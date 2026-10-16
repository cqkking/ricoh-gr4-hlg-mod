"""Gate 1 manifest checks for the GR IV HLG photo payload patch."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

from tools.fw_container import FirmwareError, parse_sections, sha256_hex, word_sum


def parse_int(value: Any) -> int:
    if isinstance(value, int):
        return value
    return int(str(value), 0)


def load_manifest(path: Path) -> Dict[str, Any]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FirmwareError(f"Unable to load patch manifest {path}: {exc}") from exc
    if manifest.get("schema_version") != 1:
        raise FirmwareError("Unsupported HLG patch manifest schema")
    if not isinstance(manifest.get("operations"), list) or not manifest["operations"]:
        raise FirmwareError("Patch manifest has no operations")
    return manifest


def _section_ranges(payload: bytes) -> Dict[str, Tuple[int, int]]:
    ranges: Dict[str, Tuple[int, int]] = {}
    for section in parse_sections(payload):
        ranges[section["name"]] = (section["data_start"], section["data_end"])
    return ranges


def _operation_ranges(manifest: Dict[str, Any], payload: bytes) -> List[Tuple[int, int, Dict[str, Any]]]:
    ranges = _section_ranges(payload)
    seen_ids = set()
    seen_ranges: List[Tuple[int, int, Dict[str, Any]]] = []
    for operation in manifest["operations"]:
        op_id = operation.get("id")
        if not op_id or op_id in seen_ids:
            raise FirmwareError(f"Duplicate or missing manifest operation id: {op_id!r}")
        seen_ids.add(op_id)
        try:
            start = parse_int(operation["payload_offset"])
            if operation.get("length") is not None:
                length = parse_int(operation["length"])
            elif operation.get("expected_hex"):
                length = len(bytes.fromhex(operation["expected_hex"]))
            elif operation.get("replacement_hex"):
                length = len(bytes.fromhex(operation["replacement_hex"]))
            else:
                raise FirmwareError(f"Missing length for operation: {op_id}")
        except (KeyError, TypeError, ValueError) as exc:
            raise FirmwareError(f"Invalid range in manifest operation {op_id}") from exc
        if start < 0 or length <= 0 or start + length > len(payload):
            raise FirmwareError(f"Manifest operation {op_id} is out of payload bounds")
        partition = operation.get("partition")
        if partition not in ranges:
            raise FirmwareError(f"Unknown partition {partition!r} in operation {op_id}")
        sec_start, sec_end = ranges[partition]
        if start < sec_start or start + length > sec_end:
            raise FirmwareError(f"Manifest operation {op_id} crosses {partition} bounds")
        for other_start, other_end, other in seen_ranges:
            if start < other_end and other_start < start + length:
                raise FirmwareError(
                    f"Manifest operations overlap: {other['id']} and {op_id}"
                )
        seen_ranges.append((start, start + length, operation))
    return seen_ranges


def validate_assets(manifest: Dict[str, Any], worktree_root: Path) -> None:
    for asset in manifest.get("assets", []):
        rel_path = asset.get("path")
        expected = asset.get("sha256", "").lower()
        path = worktree_root / rel_path
        if not path.is_file():
            raise FirmwareError(f"Manifest asset is missing: {path}")
        actual = sha256_hex(path.read_bytes())
        if actual != expected:
            raise FirmwareError(f"Manifest asset hash mismatch for {rel_path}: {actual} != {expected}")


def validate_baseline(payload: bytes, manifest: Dict[str, Any], worktree_root: Path) -> None:
    target = manifest["target"]
    if len(payload) != parse_int(target["payload_bytes"]):
        raise FirmwareError("Payload size does not match the patch manifest")
    expected_payload = target["official_payload_sha256"].lower()
    actual_payload = sha256_hex(payload)
    if actual_payload != expected_payload:
        raise FirmwareError(f"Official payload hash mismatch: {actual_payload} != {expected_payload}")
    validate_assets(manifest, worktree_root)
    for start, end, operation in _operation_ranges(manifest, payload):
        actual = payload[start:end]
        kind = operation.get("kind")
        if kind in ("replace", "derived"):
            expected = bytes.fromhex(operation["expected_hex"])
            if len(expected) != end - start or actual != expected:
                raise FirmwareError(
                    f"Original bytes mismatch for {operation['id']}: {actual.hex()} != {expected.hex()}"
                )
        elif kind == "replace_blob":
            expected = operation.get("expected_sha256", "").lower()
            if hashlib.sha256(actual).hexdigest() != expected:
                raise FirmwareError(f"Original blob hash mismatch for {operation['id']}")
        else:
            raise FirmwareError(f"Unknown manifest operation kind {kind!r}")


def validate_patched_payload(
    original: bytes, patched: bytes, manifest: Dict[str, Any]
) -> None:
    if len(original) != len(patched):
        raise FirmwareError("Patched payload length changed")
    ranges = _operation_ranges(manifest, original)
    allowed = [(start, end) for start, end, _ in ranges]
    changed = [idx for idx, (old, new) in enumerate(zip(original, patched)) if old != new]
    outside = [idx for idx in changed if not any(start <= idx < end for start, end in allowed)]
    if outside:
        raise FirmwareError(f"Payload diff escapes manifest at {outside[0]:#x}")
    for start, end, operation in ranges:
        actual = patched[start:end]
        kind = operation["kind"]
        if kind == "replace":
            expected = bytes.fromhex(operation["replacement_hex"])
            if actual != expected:
                raise FirmwareError(f"Patched bytes mismatch for {operation['id']}")
        elif kind == "replace_blob":
            expected = operation["replacement_sha256"].lower()
            if hashlib.sha256(actual).hexdigest() != expected:
                raise FirmwareError(f"Patched blob hash mismatch for {operation['id']}")
        elif kind == "derived":
            if word_sum(patched) != 0:
                raise FirmwareError("Derived checksum operation did not restore payload word_sum")


def validate_container_identity(data: bytes, manifest: Dict[str, Any]) -> None:
    expected = manifest["target"]["official_container_sha256"].lower()
    actual = sha256_hex(data)
    if actual != expected:
        raise FirmwareError(f"Official container hash mismatch: {actual} != {expected}")
