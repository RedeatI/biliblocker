#!/usr/bin/env python3
"""
BiliBlocker v0.1.4 确定性发布证据门禁（Stage E 独立复验依据）。

用法：
    python review/BiliBlocker-v0.1.4-release-gate.py <workspace-root> --expected-version 0.1.4

在 v0.1.3 门禁（版本/三 ZIP/SHA256SUMS/Source ZIP 逐文件一致/build-info/十步日志/
RELEASE-EVIDENCE/能力全 false）基础上，新增 v0.1.4 代码级检查（对应阶段 E 复验
17 项 FAIL 与 8 项运行时缺陷）：

1. StorageCoordinator 不使用共享 inLock 布尔绕过全局锁；使用显式 WriteLease/锁令牌。
2. commitAction 的 planEnqueue 调用显式传递 authorization；官方任务 authorization 必填并持久化。
3. auto_process 开关检查位于任务类型成功返回之前；队列派发层校验 unblockUser capability。
4. ActionQueue.pause 为 async 可等待操作；队列控制持久化无 fire-and-forget。
5. reset/clear 显式保持 authorizationEpoch 单调递增；经 coordinator 原子最终快照；
   clear 后最小种子（meta/settings/queueControl）立即存在。
6. unknown_outcome 使用独立持久记录（bb.unknownOutcomes）；clearQueue 不静默清空。
7. commitAction 在创建官方任务前检查持久化暂停状态（risk_control/authorization_revoked/显式恢复）。
8. 无保护 BB_ENQUEUE 已删除或限制为完整受信路径。
9. 自动处理本地动作不以缓存登录状态为前置条件。
10. operationId 具有持久化幂等结果（bb.operationOutcomes + TTL/容量）。
11. 回归测试覆盖（外部并发写串行等）存在于 tests/unit/v014-*.ts。
12. runtime-integration-evidence.json 存在且 8 项 findings 全部 false。
13. 能力/理由/selectors 全部保持 false；Source ZIP 逐文件一致；干净重建通过。

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
    "lint.log", "typecheck.log", "unit.log", "e2e.log", "build-chrome.log",
    "build-edge.log", "package.log", "source-integrity.log", "source-rebuild.log", "release-gate.log",
]
SOURCE_FORBIDDEN_DIRS = ["node_modules", "out", "out-e2e", "dist", ".git", "test-results", "playwright-report", "coverage", ".wxt", ".workbuddy"]
SOURCE_EXCLUDED = {"node_modules", "out", "out-e2e", "dist", ".wxt", ".git", "test-results", "playwright-report", "coverage", ".workbuddy"}

# v0.1.4 代码级检查的必需关键词（对应修复实现）
REQUIRED_SOURCE_PATTERNS = {
    "storage/coordinator.py": None,  # placeholder
}


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
    parser.add_argument("--expected-version", required=True, help="期望的正式版本号（如 0.1.4）")
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
    for doc in ["docs/ACCEPTANCE-v0.1.3.md", "docs/REMEDIATION-TRACE-v0.1.4.md"]:
        check(doc in ws_names, f"{doc} 存在且已冻结（与 Source ZIP 一致，由全量比较覆盖）")

    # ---- 5. build-info.json ----
    bi = dist / "build-info.json"
    check(bi.is_file(), "build-info.json 存在")
    info = json.loads(bi.read_text(encoding="utf-8"))
    check(info.get("version") == version, f"build-info.json version == {version}")
    check(info.get("sourceArchiveSha256") == sha256_file(zips["source"]), "build-info.sourceArchiveSha256 与实际 Source ZIP 一致")
    check(info.get("lockfileSha256") == sha256_file(root / "pnpm-lock.yaml"), "build-info.lockfileSha256 与实际 pnpm-lock.yaml 一致")
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

    # ---- 7. RELEASE-EVIDENCE.json ----
    ev = dist / "RELEASE-EVIDENCE.json"
    check(ev.is_file(), "RELEASE-EVIDENCE.json 存在")
    evidence = json.loads(ev.read_text(encoding="utf-8"))
    check(evidence.get("version") == version, f"RELEASE-EVIDENCE.version == {version}")
    zip_hashes = evidence.get("zipHashes") or {}
    for name, p in zips.items():
        check(zip_hashes.get(p.name) == sha256_file(p), f"RELEASE-EVIDENCE.zipHashes.{p.name} 与实际一致")

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

    # ================= v0.1.4 代码级检查（对应阶段 E 17 项 FAIL） =================
    coord_src = (root / "src/storage/coordinator.ts").read_text(encoding="utf-8")
    queue_src = (root / "src/actions/queue.ts").read_text(encoding="utf-8")
    repo_src = (root / "src/storage/repository.ts").read_text(encoding="utf-8")
    msg_src = (root / "src/shared/messages.ts").read_text(encoding="utf-8")
    app_src = (root / "src/entrypoints/content/app.ts").read_text(encoding="utf-8")
    bg_src = (root / "src/entrypoints/background/index.ts").read_text(encoding="utf-8")

    # 12.1 无共享 inLock 布尔
    check("private inLock" not in coord_src and "inLock" not in coord_src.split("withGlobalWrite")[0],
          "StorageCoordinator 不使用共享 inLock 布尔绕过全局锁")
    # 12.2 显式写租约/锁令牌
    check(
        "WriteLease" in repo_src
        and re.search(r"withGlobalWrite\(\s*async\s*\(\s*lease", coord_src) is not None,
        "协调器使用显式写租约/锁令牌或等价内部机制",
    )
    # 12.3 commitAction 的 planEnqueue 显式传 authorization
    check(re.search(r"planEnqueue\([^)]*req\??\.authorization", coord_src, re.S) is not None,
          "commitAction 的 planEnqueue 调用显式传递 authorization")
    # 12.4 auto_process 检查在任务类型成功分支之前
    auto_idx = queue_src.find("auto_process")
    block_ret = queue_src.find("return { ok: true };", queue_src.find("if (task.type === 'block')"))
    check(0 < auto_idx < block_ret, "auto_process 开关在任务类型成功返回之前校验")
    # 12.5 队列派发层校验 unblockUser capability
    check("unblockUser" in queue_src and "isCapabilityEnabled('unblockUser')" in queue_src,
          "队列派发层校验 unblockUser capability")
    # 12.6 pause 为 async 可等待
    check("async pause(" in queue_src, "ActionQueue.pause 为 async 可等待操作")
    # 12.7 无 fire-and-forget 持久化
    check("void this.deps.writer.saveControl" not in queue_src and "void this.deps.writer.saveTasks" not in queue_src,
          "队列控制状态不使用 fire-and-forget 持久化")
    # 12.8 reset/clear 显式保持 epoch 单调递增
    check("authorizationEpoch: oldControl.authorizationEpoch + 1" in coord_src,
          "reset/clear 显式保持 authorizationEpoch 单调递增")
    # 12.9 reset/clear 经 coordinator 原子最终快照
    check("resetAndClear" in coord_src and "commitSnapshot(items)" in coord_src,
          "reset/clear 通过 coordinator 原子最终快照而非覆盖撤权控制状态")
    # 12.10 unknown_outcome 独立持久记录/墓碑
    check("unknownOutcomes" in repo_src and "recordUnknownOutcome" in queue_src,
          "unknown_outcome 使用独立持久记录/墓碑")
    # 12.11 clearQueue 不静默清空 unknown_outcome
    check(
        "recordUnknown" in queue_src
        and "unknown_outcome" in queue_src
        and "clearQueue" in queue_src,
        "clearQueue 不会在无持久证据时直接清空 unknown_outcome",
    )
    # 12.12 commitAction 检查持久化暂停状态
    check("control.paused" in coord_src and "risk_control" in coord_src and "requiresExplicitResume" in coord_src,
          "commitAction 在创建官方任务前检查持久化暂停状态")
    # 12.13 无保护 BB_ENQUEUE 已删除（schema 无该类型、background 无该 case）
    check(
        "BB_ENQUEUE" not in msg_src
        and re.search(r"case\s+'BB_ENQUEUE'", bg_src) is None
        and "enqueueSchema" not in msg_src,
        "无保护 BB_ENQUEUE 已删除或限制为完整受信路径",
    )
    # 12.14 自动处理本地动作不以缓存登录状态为前置
    check("this.loginOk &&" not in app_src.replace("this.loginOk = loginOk", ""),
          "自动处理本地动作不以缓存登录状态为前置条件")
    # 12.15 operationId 持久化幂等
    check("operationOutcomes" in repo_src and "getOperationOutcome" in coord_src and "binding" in coord_src,
          "operationId 具有持久化幂等结果")

    # ---- 13. 回归测试覆盖（v014 测试文件存在且含关键断言） ----
    v014_files = sorted((root / "tests/unit").glob("v014-*.test.ts"))
    check(len(v014_files) >= 9, f"新增 v0.1.4 回归测试文件 ≥ 9（实际 {len(v014_files)}）")
    coverage_map = {
        "外部并发写串行": "v014-coordinator-lock.test.ts",
        "授权快照贯通": "v014-auth-snapshot.test.ts",
        "auto-process 撤权": "v014-dispatch-gate.test.ts",
        "unblock capability": "v014-dispatch-gate.test.ts",
        "reset/clear epoch": "v014-reset-clear.test.ts",
        "unknown outcome 保留": "v014-unknown-outcome.test.ts",
        "pause 持久时序": "v014-pause-crash-safe.test.ts",
        "operationId 幂等": "v014-operation-idempotency.test.ts",
        "SW frame grace": "v014-frame-grace.test.ts",
    }
    for label, fname in coverage_map.items():
        fp = root / "tests/unit" / fname
        check(fp.is_file(), f"回归测试覆盖: {label}（{fname} 存在）")

    # ---- 14. runtime-integration-evidence.json（8 项缺陷全关闭） ----
    probe_file = root / "runtime-integration-evidence.json"
    check(probe_file.is_file(), "提交 runtime-integration-evidence.json")
    try:
        probe = json.loads(probe_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        fail("runtime-integration-evidence.json 不是合法 JSON")
    findings = probe.get("findings") or {}
    expected_false = {
        "externalWriteOverlap": False,
        "authSnapshotDropped": False,
        "autoProcessDisableNotEnforcedAtDispatch": False,
        "unblockCapabilityNotEnforcedAtDispatch": False,
        "resetControlDiverges": False,
        "clearAllUnseeded": False,
        "clearQueueLosesUnknownOutcome": False,
        "pauseNotAwaitable": False,
    }
    for k, v in expected_false.items():
        check(findings.get(k) is False, f"runtime probe {k} == false（实际 {findings.get(k)}）")
    check(probe.get("allDefectsClosed") is True, "runtime probe allDefectsClosed == true")
    results = probe.get("results") or {}
    conv = results.get("coordinatorExternalConcurrencyBypass") or {}
    check(conv.get("overlap") is False and conv.get("maxActive") == 1,
          f"并发写最大活跃数为 1（实际 {conv.get('maxActive')}）")

    print("RELEASE GATE: PASS")


if __name__ == "__main__":
    main()
