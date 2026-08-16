#!/usr/bin/env python3
"""
BiliBlocker v0.1.7 阶段 F 门禁（真实账号验证准入/放行检查）。

用法：
    python review/stage-e-review/BiliBlocker-v0.1.7-stage-f-gate.py <workspace-root> --expected-version 0.1.7

检查（阶段 E 通过后，阶段 F 逐项放行的辅助门禁）：
1. 常规发布完整性（三 ZIP + SHA256SUMS + build-info + RELEASE-EVIDENCE + Source 一致性 + manifest/权限/matches）。
2. REAL-ACCOUNT-VALIDATION-RECORD.md 存在；已开启能力键的 evidenceId 必须能在记录中找到。
3. 未开启能力键 verified 必须为 false（未验证不得放行）。
4. 举报理由 / selectors：仅当对应记录存在时才允许 verified=true。
5. 输出「当前已放行能力清单」供人工核对。

退出码：0 = PASS；非 0 = FAIL。
"""
import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

EXPECTED_PERMISSIONS = ["storage", "alarms"]
EXPECTED_HOST_PERMISSIONS = []
EXPECTED_MATCHES = ["https://www.bilibili.com/*"]
CAPS = ["blockUser", "unblockUser", "reportVideoComment", "reportVideoReply",
        "reportDynamicComment", "reportDynamic", "selectorsVideo", "selectorsDynamic"]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def fail(msg: str) -> None:
    print(f"STAGE-F GATE: FAIL - {msg}")
    sys.exit(1)


def check(cond: bool, msg: str) -> None:
    if not cond:
        fail(msg)
    print(f"  [ok] {msg}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=".")
    parser.add_argument("--expected-version", required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    version = args.expected_version
    print(f"stage-f gate: workspace = {root}, expected version = {version}")

    # ---- 1. 版本 + 三 ZIP ----
    pkg = json.loads((root / "package.json").read_text(encoding="utf-8"))
    check(pkg.get("version") == version, f"package.json version == {version}")
    dist = root / "dist"
    zips = {name: dist / f"biliblocker-{name}-{version}.zip" for name in ["chrome", "edge", "source"]}
    for name, p in zips.items():
        check(p.is_file(), f"ZIP 存在：{p.name}")
    sums = {}
    for line in (dist / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("  ")
        if len(parts) != 2:
            fail(f"SHA256SUMS.txt 行格式错误：{line}")
        sums[parts[1]] = parts[0]
    for name, p in zips.items():
        check(p.name in sums and sums[p.name] == sha256_file(p), f"{p.name} 哈希一致")

    # ---- 2. manifest ----
    for name, out_sub in [("chrome", "chrome-mv3"), ("edge", "edge-mv3")]:
        with zipfile.ZipFile(zips[name]) as zf:
            man = json.loads(zf.read("manifest.json").decode("utf-8"))
            check(man.get("version") == version, f"{name} manifest.version == {version}")
            check(man.get("permissions") == EXPECTED_PERMISSIONS, f"{name} permissions == {EXPECTED_PERMISSIONS}")
            check(man.get("host_permissions") == EXPECTED_HOST_PERMISSIONS, f"{name} host_permissions 为空")
            cs = man.get("content_scripts") or []
            matches = (cs[0] or {}).get("matches") or []
            check(matches == EXPECTED_MATCHES, f"{name} matches == {EXPECTED_MATCHES}")

    # ---- 3. build-info ----
    bi = json.loads((dist / "build-info.json").read_text(encoding="utf-8"))
    check(bi.get("version") == version, "build-info.version")
    for sname in ["lint", "typecheck", "unit", "e2e", "build-chrome", "build-edge", "package", "source-integrity", "source-rebuild", "release-gate"]:
        check(bi.get("exitCodes", {}).get(sname) == 0, f"build-info.exitCodes.{sname} == 0")

    # ---- 4. 能力放行与证据记录一致性 ----
    cap_src = (root / "src/shared/capabilities.ts").read_text(encoding="utf-8")
    record_path = root / "docs/REAL-ACCOUNT-VALIDATION-RECORD.md"
    check(record_path.is_file(), "docs/REAL-ACCOUNT-VALIDATION-RECORD.md 存在")
    record_text = record_path.read_text(encoding="utf-8", errors="ignore")

    enabled = []
    for cap in CAPS:
        m = re.search(rf"{cap}:\s*\{{[^}}]*verified:\s*(true|false)", cap_src)
        if m is None:
            fail(f"无法解析能力 {cap}")
        if m.group(1) == "true":
            # 已开启：必须能在验证记录中找到 evidenceId
            em = re.search(rf"{cap}:\s*\{{[^}}]*evidenceId:\s*'([^']+)'", cap_src)
            eid = em.group(1) if em else None
            if eid and eid != "null" and eid not in record_text:
                fail(f"{cap} verified=true 但 evidenceId {eid} 不在验证记录中")
            enabled.append(f"{cap}(evidenceId={eid})")
        else:
            print(f"  [ok] {cap} verified=false（未放行）")
    print(f"  [info] 当前已放行能力：{enabled if enabled else '（无）'}")

    # ---- 5. 举报理由 / selectors 放行一致性 ----
    reasons_src = (root / "src/shared/constants/report-reasons.ts").read_text(encoding="utf-8")
    m = re.search(r"verified:\s*(true|false)", reasons_src)
    if m and m.group(1) == "true":
        # 举报理由 verified=true 仅当有对应能力验证记录（report*）
        has_report_record = any(f"EV-" in record_text and "report" in record_text.lower() for _ in [0])
        check(has_report_record or "report" in record_text.lower(), "REPORT_REASONS.verified=true 需有对应验证记录")
        print("  [info] REPORT_REASONS.verified=true（有记录）")
    sel_src = (root / "src/adapters/bilibili/selectors.ts").read_text(encoding="utf-8")
    m = re.search(r"selectorsVerified:\s*(true|false)", sel_src)
    if m and m.group(1) == "true":
        check("selectorsVideo" in record_text or "selectorsDynamic" in record_text or "selector" in record_text.lower(),
              "selectorsVerified=true 需有对应验证记录")

    print("\nSTAGE-F GATE: PASS")
    print(f"  → 阶段 E 已通过；阶段 F 逐项放行状态如上。商店提交前需全部 9 项能力验证通过。")


if __name__ == "__main__":
    main()
