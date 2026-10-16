#!/usr/bin/env python3
"""Independent Gate 1 verifier for the GR IV HLG photo firmware candidate."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tools.fw_container import FirmwareError, decode_container, parse_sections, sha256_hex, verify_container, word_sum



def parse_int(value: Any) -> int:
    return value if isinstance(value, int) else int(str(value), 0)


def load_manifest(path: Path) -> Dict[str, Any]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1:
        raise FirmwareError("Unsupported manifest schema")
    return manifest


def ranges_for(payload: bytes, manifest: Dict[str, Any]) -> List[Tuple[int, int, Dict[str, Any]]]:
    sections = {s["name"]: (s["data_start"], s["data_end"]) for s in parse_sections(payload)}
    result: List[Tuple[int, int, Dict[str, Any]]] = []
    ids = set()
    for op in manifest["operations"]:
        op_id = op["id"]
        if op_id in ids:
            raise FirmwareError(f"Duplicate operation id: {op_id}")
        ids.add(op_id)
        start = parse_int(op["payload_offset"])
        if op.get("length") is not None:
            length = parse_int(op["length"])
        elif op.get("expected_hex"):
            length = len(bytes.fromhex(op["expected_hex"]))
        elif op.get("replacement_hex"):
            length = len(bytes.fromhex(op["replacement_hex"]))
        else:
            raise FirmwareError(f"Missing length for operation: {op_id}")
        end = start + length
        if start < 0 or end > len(payload) or end <= start:
            raise FirmwareError(f"Out-of-range operation: {op_id}")
        if op["partition"] not in sections:
            raise FirmwareError(f"Unknown partition in operation: {op_id}")
        sec_start, sec_end = sections[op["partition"]]
        if start < sec_start or end > sec_end:
            raise FirmwareError(f"Operation crosses partition boundary: {op_id}")
        for other_start, other_end, other in result:
            if start < other_end and other_start < end:
                raise FirmwareError(f"Overlapping operations: {other['id']} and {op_id}")
        result.append((start, end, op))
    return result


def check_assets(root: Path, manifest: Dict[str, Any]) -> None:
    for asset in manifest.get("assets", []):
        path = root / asset["path"]
        actual = sha256_hex(path.read_bytes())
        if actual != asset["sha256"].lower():
            raise FirmwareError(f"Asset hash mismatch: {asset['path']}")


def check_original(payload: bytes, manifest: Dict[str, Any], ranges: List[Tuple[int, int, Dict[str, Any]]]) -> None:
    for start, end, op in ranges:
        actual = payload[start:end]
        if op["kind"] in ("replace", "derived"):
            expected = bytes.fromhex(op["expected_hex"])
            if actual != expected:
                raise FirmwareError(f"Original bytes mismatch: {op['id']}")
        elif hashlib.sha256(actual).hexdigest() != op["expected_sha256"].lower():
            raise FirmwareError(f"Original blob hash mismatch: {op['id']}")


def check_candidate(
    original: bytes,
    candidate: bytes,
    manifest: Dict[str, Any],
    ranges: List[Tuple[int, int, Dict[str, Any]]],
) -> int:
    changed = [i for i, (old, new) in enumerate(zip(original, candidate)) if old != new]
    allowed = [(start, end) for start, end, _ in ranges]
    outside = [i for i in changed if not any(start <= i < end for start, end in allowed)]
    if outside:
        raise FirmwareError(f"Diff outside manifest at payload offset {outside[0]:#x}")
    for start, end, op in ranges:
        actual = candidate[start:end]
        if op["kind"] == "replace":
            if actual != bytes.fromhex(op["replacement_hex"]):
                raise FirmwareError(f"Candidate bytes mismatch: {op['id']}")
        elif op["kind"] == "replace_blob":
            if hashlib.sha256(actual).hexdigest() != op["replacement_sha256"].lower():
                raise FirmwareError(f"Candidate blob hash mismatch: {op['id']}")
    if word_sum(candidate) != 0:
        raise FirmwareError("Candidate payload word_sum is not zero")
    return len(changed)


def verify(official_path: Path, candidate_path: Path, manifest_path: Path) -> Dict[str, Any]:
    manifest = load_manifest(manifest_path)
    root = manifest_path.parent.parent
    check_assets(root, manifest)
    official_data = official_path.read_bytes()
    candidate_data = candidate_path.read_bytes()
    if sha256_hex(official_data) != manifest["target"]["official_container_sha256"].lower():
        raise FirmwareError("Official input SHA-256 does not match manifest")
    official_payload, _, official_used = decode_container(official_data)
    candidate_payload, candidate_frames, candidate_used = decode_container(candidate_data)
    verify_container(official_data, official_payload, official_used)
    verify_container(candidate_data, candidate_payload, candidate_used)
    if sha256_hex(official_payload) != manifest["target"]["official_payload_sha256"].lower():
        raise FirmwareError("Official decoded payload SHA-256 does not match manifest")
    if len(candidate_payload) != parse_int(manifest["target"]["payload_bytes"]):
        raise FirmwareError("Candidate payload size does not match manifest")
    ranges = ranges_for(official_payload, manifest)
    check_original(official_payload, manifest, ranges)
    changed = check_candidate(official_payload, candidate_payload, manifest, ranges)
    return {
        "status": "PASS",
        "official_sha256": sha256_hex(official_data),
        "candidate_sha256": sha256_hex(candidate_data),
        "official_payload_sha256": sha256_hex(official_payload),
        "candidate_payload_sha256": sha256_hex(candidate_payload),
        "candidate_bytes": len(candidate_data),
        "candidate_payload_bytes": len(candidate_payload),
        "candidate_frames": len(candidate_frames),
        "changed_payload_bytes": changed,
        "manifest_operations": len(ranges),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--official", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--json", type=Path, help="Optional JSON result path")
    args = parser.parse_args(argv)
    try:
        result = verify(args.official, args.candidate, args.manifest)
    except (FirmwareError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if args.json:
        args.json.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
