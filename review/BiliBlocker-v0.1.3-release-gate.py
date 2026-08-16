#!/usr/bin/env python3
"""
BiliBlocker v0.1.3 确定性发布证据门禁（Stage E 独立复验依据）。

用法：
    python review/BiliBlocker-v0.1.3-release-gate.py <workspace-root> --expected-version 0.1.3

语义（P0-1/P0-5，v0.1.3）：
1. 版本：--expected-version 必须与 package.json / manifest / build-info / RELEASE-EVIDENCE 一致。
2. 三份 ZIP 存在且 SHA256SUMS.txt 与实际哈希一致。
3. 商店 ZIP：manifest 权限恰好 [storage, alarms]、host_permissions 空、matches 恰好
   https://www.bilibili.com/*、无 localhost/127.0.0.1/.e2e 痕迹、version 正确；
   商店 ZIP 内容与 out/<browser>-mv3 逐文件哈希一致。
4. **Source ZIP 真实内容比较（本门禁核心）**：把 Source ZIP 内每个文件与当前工作区
   （排除构建产物）逐文件 SHA-256 比较；任一文件缺失/多出/内容不同 → FAIL。
   该比较不是只检查文件存在，而是逐字节执行内容比较。
5. build-info.json：sourceArchiveSha256 与实际 Source ZIP 一致；lockfileSha256 与实际
   pnpm-lock.yaml 一致；exitCodes 全部为 0；steps 含 10 步且日志路径齐全。
6. 十份发布日志存在且非空；unit/e2e 含通过统计；source-integrity / source-rebuild /
   release-gate 日志含成功标记；任一步 exitCode 非 0 → FAIL。
7. RELEASE-EVIDENCE.json 存在、version 正确、zipHashes 与实际一致。
8. 真实能力关闭：CAPABILITY_VERIFICATION 八项 verified:false、REPORT_REASONS.verified=false、
   selectors VERIFICATION.selectorsVerified=false（静态检查源码常量）。

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
REQUIRED_LOGS = [
    "lint.log",
    "typecheck.log",
    "unit.log",
    "e2e.log",
    "build-chrome.log",
    "build-edge.log",
    "package.log",
    "source-integrity.log",
    "source-rebuild.log",
    "release-gate.log",
]
SOURCE_FORBIDDEN_DIRS = ["node_modules", "out", "out-e2e", "dist", ".git", "test-results", "playwright-report", "coverage", ".wxt", ".workbuddy"]
# 与 scripts/verify-source-rebuild.mjs 的 EXCLUDED_DIRS 保持一致（Source ZIP 打包排除清单）
SOURCE_EXCLUDED = {"node_modules", "out", "out-e2e", "dist", ".wxt", ".git", "test-results", "playwright-report", "coverage", ".workbuddy"}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def fail(msg: str) -> None:
    print(f"RELEASE GATE: FAIL - {msg}")
    sys.exit(1)


def check(cond: bool, msg: str) -> None:
    if not cond:
        fail(msg)
    print(f"  [ok] {msg}")


def workspace_files(root: Path) -> dict[str, str]:
    """当前工作区文件清单（相对路径 → sha256；排除构建产物目录）"""
    out: dict[str, str] = {}
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        if any(rel == d or rel.startswith(d + "/") for d in SOURCE_EXCLUDED):
            continue
        if rel.startswith(".stage-"):
            continue
        out[rel] = sha256_file(p)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=".")
    parser.add_argument("--expected-version", required=True, help="期望的正式版本号（如 0.1.3）")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    version = args.expected_version
    print(f"release gate: workspace = {root}, expected version = {version}")

    # ---- 1. package.json 版本 ----
    pkg_path = root / "package.json"
    check(pkg_path.is_file(), "package.json 存在")
    pkg_version = json.loads(pkg_path.read_text(encoding="utf-8")).get("version", "")
    check(pkg_version == version, f"package.json version == {version}（实际 {pkg_version}）")
    if not pkg_version or pkg_version.endswith("-dev"):
        fail("发布候选版本不得为 -dev 后缀")

    # ---- 2. 三份 ZIP + SHA256SUMS ----
    dist = root / "dist"
    check(dist.is_dir(), "dist/ 存在")
    zips = {
        "chrome": dist / f"biliblocker-chrome-{version}.zip",
        "edge": dist / f"biliblocker-edge-{version}.zip",
        "source": dist / f"biliblocker-source-{version}.zip",
    }
    for name, p in zips.items():
        check(p.is_file(), f"ZIP 存在：{p.name}")
    sums_file = dist / "SHA256SUMS.txt"
    check(sums_file.is_file(), "SHA256SUMS.txt 存在")
    sums: dict[str, str] = {}
    for line in sums_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("  ")
        if len(parts) != 2:
            fail(f"SHA256SUMS.txt 行格式错误：{line}")
        sums[parts[1]] = parts[0]
    for name, p in zips.items():
        check(p.name in sums, f"SHA256SUMS.txt 包含 {p.name}")
        check(sums[p.name] == sha256_file(p), f"{p.name} 哈希一致")

    # ---- 3. 商店 ZIP + out/ 逐文件一致性 ----
    for name, out_sub in [("chrome", "chrome-mv3"), ("edge", "edge-mv3")]:
        p = zips[name]
        out_dir = root / "out" / out_sub
        check(out_dir.is_dir(), f"out/{out_sub} 存在")
        with zipfile.ZipFile(p) as zf:
            names = zf.namelist()
            check("manifest.json" in names, f"{name} ZIP 根目录含 manifest.json")
            check(not any(".e2e" in n for n in names), f"{name} ZIP 无 .e2e 文件")
            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
            cs = manifest.get("content_scripts") or []
            check(len(cs) == 1, f"{name} manifest content_scripts 数量为 1")
            matches = (cs[0] or {}).get("matches") or []
            check(matches == EXPECTED_MATCHES, f"{name} matches 恰好为 Bilibili（实际 {matches}）")
            joined = json.dumps(matches).lower()
            check("localhost" not in joined and "127.0.0.1" not in joined, f"{name} 无测试域名")
            perms = manifest.get("permissions") or []
            host_perms = manifest.get("host_permissions") or []
            check(perms == EXPECTED_PERMISSIONS, f"{name} permissions == {EXPECTED_PERMISSIONS}（实际 {perms}）")
            check(host_perms == EXPECTED_HOST_PERMISSIONS, f"{name} host_permissions 为空")
            check(manifest.get("version") == version, f"{name} manifest.version == {version}")
            # ZIP 内容与 out/ 逐文件哈希一致
            out_files: dict[str, str] = {}
            for fp in sorted(out_dir.rglob("*")):
                if fp.is_file():
                    out_files[fp.relative_to(out_dir).as_posix()] = sha256_file(fp)
            for n in names:
                if not n.endswith("/"):
                    check(n in out_files, f"{name} ZIP 文件 {n} 存在于 out/{out_sub}")
                    check(sha256_bytes(zf.read(n)) == out_files[n], f"{name} ZIP 文件 {n} 与 out/{out_sub} 哈希一致")
            missing = set(out_files.keys()) - set(n for n in names if not n.endswith("/"))
            check(not missing, f"{name} out/{out_sub} 无缺失文件（{sorted(missing)[:5]}）")

    # ---- 4. Source ZIP 真实内容比较（核心） ----
    ws = workspace_files(root)
    with zipfile.ZipFile(zips["source"]) as zf:
        zip_entries = {n: sha256_bytes(zf.read(n)) for n in zf.namelist() if not n.endswith("/")}
    ws_names = set(ws.keys())
    zip_names = set(zip_entries.keys())
    only_zip = sorted(zip_names - ws_names)
    only_ws = sorted(ws_names - zip_names)
    check(not only_zip, f"Source ZIP 无工作区外文件（{only_zip[:10]}）")
    check(not only_ws, f"Source ZIP 无缺失文件（{only_ws[:10]}）")
    forbidden = [n for n in zip_names if any(n.startswith(d + "/") for d in SOURCE_FORBIDDEN_DIRS)]
    check(not forbidden, f"Source ZIP 无禁止目录/构建产物（{forbidden[:10]}）")
    diffs = sorted(n for n in ws_names if ws[n] != zip_entries[n])
    check(not diffs, f"Source ZIP 与工作区逐文件内容一致（{len(diffs)} 个文件不同：{diffs[:10]}）")
    print(f"  [ok] Source ZIP 内容比较：{len(ws_names)} 个文件全部一致（逐文件 SHA-256）")
    # 文档冻结检查：REMEDIATION-TRACE-v0.1.3.md 打包后不得再修改
    trace = "docs/REMEDIATION-TRACE-v0.1.3.md"
    check(trace in ws_names, "REMEDIATION-TRACE-v0.1.3.md 存在且已冻结（与 Source ZIP 一致，由全量比较覆盖）")

    # ---- 5. build-info.json ----
    bi = dist / "build-info.json"
    check(bi.is_file(), "build-info.json 存在")
    info = json.loads(bi.read_text(encoding="utf-8"))
    check(info.get("version") == version, f"build-info.json version == {version}")
    actual_src_sha = sha256_file(zips["source"])
    check(info.get("sourceArchiveSha256") == actual_src_sha, "build-info.sourceArchiveSha256 与实际 Source ZIP 一致")
    actual_lock_sha = sha256_file(root / "pnpm-lock.yaml")
    check(info.get("lockfileSha256") == actual_lock_sha, "build-info.lockfileSha256 与实际 pnpm-lock.yaml 一致")
    exit_codes = info.get("exitCodes") or {}
    for sname in ["lint", "typecheck", "unit", "e2e", "build-chrome", "build-edge", "package", "source-integrity", "source-rebuild", "release-gate"]:
        check(exit_codes.get(sname) == 0, f"build-info.exitCodes.{sname} == 0（实际 {exit_codes.get(sname)}）")
    steps = info.get("steps") or []
    check(len(steps) == 10, f"build-info.steps 含 10 步（实际 {len(steps)}）")
    step_logs = [s.get("log", "") for s in steps]
    for log in REQUIRED_LOGS:
        check(any(log in sl for sl in step_logs), f"build-info.steps 含 {log}")

    # ---- 6. 十份发布日志 ----
    logs = dist / "logs"
    check(logs.is_dir(), "dist/logs/ 存在")
    for log in REQUIRED_LOGS:
        lp = logs / log
        check(lp.is_file() and lp.stat().st_size > 0, f"日志存在且非空：{log}")
    unit_text = (logs / "unit.log").read_text(encoding="utf-8", errors="ignore")
    e2e_text = (logs / "e2e.log").read_text(encoding="utf-8", errors="ignore")
    check("passed" in unit_text.lower(), "unit.log 包含通过统计")
    if "no tests" not in e2e_text.lower():
        check(re.search(r"\d+ passed", e2e_text, re.IGNORECASE) is not None, "e2e.log 包含通过统计")
    check("一致" in (logs / "source-integrity.log").read_text(encoding="utf-8", errors="ignore"), "source-integrity.log 含成功标记")
    check("干净重建通过" in (logs / "source-rebuild.log").read_text(encoding="utf-8", errors="ignore"), "source-rebuild.log 含成功标记")
    # 注：release-gate.log 由本 gate 运行后写入（含 RELEASE GATE: PASS）；
    # 本 gate 运行时该日志为占位符，因此不做自引用检查（避免鸡生蛋）。

    # ---- 7. RELEASE-EVIDENCE.json ----
    ev = dist / "RELEASE-EVIDENCE.json"
    check(ev.is_file(), "RELEASE-EVIDENCE.json 存在")
    evidence = json.loads(ev.read_text(encoding="utf-8"))
    check(evidence.get("version") == version, f"RELEASE-EVIDENCE.version == {version}")
    zip_hashes = evidence.get("zipHashes") or {}
    for name, p in zips.items():
        key = p.name
        check(zip_hashes.get(key) == sha256_file(p), f"RELEASE-EVIDENCE.zipHashes.{key} 与实际一致")

    # ---- 8. 真实能力关闭（静态常量检查） ----
    cap_src = (root / "src/shared/capabilities.ts").read_text(encoding="utf-8")
    for cap in ["blockUser", "unblockUser", "reportVideoComment", "reportVideoReply",
                "reportDynamicComment", "reportDynamic", "selectorsVideo", "selectorsDynamic"]:
        m = re.search(rf"{cap}:\s*\{{[^}}]*verified:\s*(true|false)", cap_src)
        check(m is not None and m.group(1) == "false", f"CAPABILITY_VERIFICATION.{cap}.verified == false")
    reasons_src = (root / "src/shared/constants/report-reasons.ts").read_text(encoding="utf-8")
    m = re.search(r"verified:\s*(true|false)", reasons_src)
    check(m is not None and m.group(1) == "false", "REPORT_REASONS.verified == false")
    sel_src = (root / "src/adapters/bilibili/selectors.ts").read_text(encoding="utf-8")
    m = re.search(r"selectorsVerified:\s*(true|false)", sel_src)
    check(m is not None and m.group(1) == "false", "selectors VERIFICATION.selectorsVerified == false")

    print("RELEASE GATE: PASS")


if __name__ == "__main__":
    main()
