#!/usr/bin/env python3
"""
BiliBlocker 发布门禁（release gate）。

用法：python review/release_gate.py <workspace-root>

校验内容（对应 docs/ACCEPTANCE-v0.1.0.md 阶段 5 复验定义 + ACCEPTANCE-v0.1.1.md P0-4）：
1. 三份 ZIP 存在且文件名符合 biliblocker-{chrome,edge,source}-{VERSION}.zip（VERSION 取自 package.json）。
2. SHA256SUMS.txt 与实测哈希一致。
3. 商店 ZIP：manifest.json 在根目录；content_scripts.matches 恰好为
   https://www.bilibili.com/*；无 localhost/127.0.0.1；无 .e2e-built 文件；
   permissions 恰好为 [storage, alarms]；host_permissions 为空；version == VERSION。
4. Source ZIP：含 package.json、pnpm-lock.yaml、src/、scripts/；
   不含 node_modules/、out/、out-e2e/、dist/、.git/、test-results/。
5. dist/logs/*.log 齐全且非空；unit/e2e 日志包含通过统计。
6. build-info.json 存在且 version 正确（含 builtAt/sourceArchiveSha256/node/pnpm/playwright/browser/tests/steps）。
退出码：0 = PASS；非 0 = FAIL（输出 RELEASE GATE: FAIL 与原因）。
"""
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

# 版本取自 package.json（唯一来源），避免随版本升级重复改本文件
ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8")).get("version", "")
if not VERSION or VERSION.endswith("-dev"):
    print(f"RELEASE GATE: FAIL - package.json 版本非法（{VERSION}），发布候选必须是正式版本号（非 -dev 后缀）")
    sys.exit(1)
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
    "release-gate.log",
]
SOURCE_FORBIDDEN_DIRS = ["node_modules", "out", "out-e2e", "dist", ".git", "test-results", "playwright-report", "coverage", ".wxt"]


def sha256(path: Path) -> str:
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


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    print(f"release gate: workspace = {root}")

    dist = root / "dist"
    check(dist.is_dir(), "dist/ 存在")

    zips = {
        "chrome": dist / f"biliblocker-chrome-{VERSION}.zip",
        "edge": dist / f"biliblocker-edge-{VERSION}.zip",
        "source": dist / f"biliblocker-source-{VERSION}.zip",
    }
    for name, p in zips.items():
        check(p.is_file(), f"ZIP 存在：{p.name}")

    # SHA256SUMS 一致性
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
        rel = p.name
        check(rel in sums, f"SHA256SUMS.txt 包含 {rel}")
        check(sums[rel] == sha256(p), f"{rel} 哈希一致")

    # 商店 ZIP 校验
    for name in ("chrome", "edge"):
        p = zips[name]
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
            check(manifest.get("version") == VERSION, f"{name} manifest.version == {VERSION}")
            # 全文件内容扫描测试痕迹（仅文本类文件）
            for n in names:
                if n.endswith((".js", ".json", ".html", ".css")):
                    data = zf.read(n).decode("utf-8", errors="ignore")
                    if ".e2e-built" in data or "127.0.0.1" in data and "bilibili.com" not in data:
                        fail(f"{name} ZIP 文件 {n} 含测试痕迹")

    # Source ZIP 校验
    with zipfile.ZipFile(zips["source"]) as zf:
        names = set(zf.namelist())
        for req in ("package.json", "pnpm-lock.yaml", "src/", "scripts/"):
            check(any(n.startswith(req.rstrip("/")) for n in names), f"source ZIP 含 {req}")
        for forbidden in SOURCE_FORBIDDEN_DIRS:
            check(not any(n.startswith(forbidden + "/") for n in names), f"source ZIP 不含 {forbidden}/")
        pkg = json.loads(zf.read("package.json").decode("utf-8"))
        check(pkg.get("version") == VERSION, f"source package.json version == {VERSION}")

    # 日志
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

    # build-info（P0-4：最低字段 version/builtAt/sourceArchiveSha256/node/pnpm/playwright/browser/tests/steps）
    bi = dist / "build-info.json"
    check(bi.is_file(), "build-info.json 存在")
    info = json.loads(bi.read_text(encoding="utf-8"))
    check(info.get("version") == VERSION, f"build-info.json version == {VERSION}")
    for key in ("builtAt", "sourceArchiveSha256", "nodeVersion", "pnpmVersion", "playwrightVersion", "browserVersion"):
        check(key in info and info[key], f"build-info.json 含 {key}")
    check("tests" in info and "unit" in info.get("tests", {}) and "e2e" in info.get("tests", {}), "build-info.json tests{unit,e2e}")
    check(isinstance(info.get("steps"), list) and len(info["steps"]) >= 8, "build-info.json steps[] 齐全（≥8 步）")

    print("RELEASE GATE: PASS")


if __name__ == "__main__":
    main()
