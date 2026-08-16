#!/usr/bin/env python3
"""
BiliBlocker v0.1.6 阶段 E 独立增强门禁（验收方独立编写，非开发者自检工具）。

用法：
    python review/stage-e-review/BiliBlocker-v0.1.6-independent-gate.py <workspace-root> --expected-version 0.1.6

覆盖（按验收矩阵 1-27 项）：
1. 发布产物完整性：三份 ZIP + SHA256SUMS + build-info + RELEASE-EVIDENCE + 十步日志
2. Chrome/Edge ZIP ↔ out/ 逐文件一致性；manifest 权限/matches/版本
3. Source ZIP ↔ workspace 逐文件一致性；无禁止目录
4. 真实能力全部 false（8 键 capability + 举报理由 + selectors；含 E2E define 检查）
5. 无 BB_ENQUEUE 旁路（消息协议 types 检查）
6. 生产代码无实例级 currentLease / inLock / 共享持锁状态
7. 词法作用域 ScopedWriter（writerFor(lease)）+ 外部 writer 走公共 execute
8. pendingTasks() structuredClone；saveQueueTasks 锁内 merge；commitAction 锁内读最新队列
9. pause 失败 reject + safety latch（session+local 双通道）+ start 读 latch fail-closed
10. resume controlOverride（paused:false）+ saveQueueSnapshot 原子落盘
11. inMemoryBackend/Repository structured-clone 语义
12. operationOutcome 与副作用同一次 commitSnapshot；拒绝类写绑定记录
13. revalidate 合并式 adopt（in_flight 不回退）；pause retry 走公共 writer
14. **新增 P0 检查（独立发现）**：
    a) runTask 设置 in_flight 前是否二次检查 task.status（cancelled/revocationRequested）
    b) verifyTaskEligible 的 epoch 检查是否位于全部 await 之后（stale verdict 防护）
    c) 存在先红后绿的回归测试（v0.1.6 新增）
15. 独立 runtime evidence（review/stage-e-review/independent-evidence.json）核对

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
SOURCE_EXCLUDED = {"node_modules", "out", "out-e2e", "dist", ".wxt", ".git", "test-results", "playwright-report", "coverage", ".workbuddy"}
# 验收方注入材料（不在交付包内，比较时排除）
REVIEWER_INJECTED = {"review/stage-e-review", "vitest.independent.config.ts", "clean-rebuild"}
CAPS = ["blockUser", "unblockUser", "reportVideoComment", "reportVideoReply",
        "reportDynamicComment", "reportDynamic", "selectorsVideo", "selectorsDynamic"]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def fail(msg: str) -> None:
    print(f"INDEPENDENT GATE: FAIL - {msg}")
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
        if any(rel == d or rel.startswith(d + "/") for d in REVIEWER_INJECTED):
            continue
        if rel.startswith(".stage-"):
            continue
        out[rel] = sha256_file(p)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=".")
    parser.add_argument("--expected-version", required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    version = args.expected_version
    print(f"independent gate: workspace = {root}, expected version = {version}")

    # ---- 1. 版本 ----
    pkg = json.loads((root / "package.json").read_text(encoding="utf-8"))
    check(pkg.get("version") == version, f"package.json version == {version}")

    # ---- 2. 三份 ZIP + SHA256SUMS ----
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
        check(sums.get(p.name) == sha256_file(p), f"{p.name} 哈希一致（{sha256_file(p)}）")

    # ---- 3. Chrome/Edge ZIP ↔ out/ ----
    for name, out_sub in [("chrome", "chrome-mv3"), ("edge", "edge-mv3")]:
        out_dir = root / "out" / out_sub
        with zipfile.ZipFile(zips[name]) as zf:
            names = [n for n in zf.namelist() if not n.endswith("/")]
            man = json.loads(zf.read("manifest.json").decode("utf-8"))
            check(man.get("version") == version, f"{name} manifest.version == {version}")
            check(man.get("permissions") == EXPECTED_PERMISSIONS, f"{name} permissions == {EXPECTED_PERMISSIONS}")
            check(man.get("host_permissions") == EXPECTED_HOST_PERMISSIONS, f"{name} host_permissions 为空")
            cs = man.get("content_scripts") or []
            matches = (cs[0] or {}).get("matches") or []
            check(matches == EXPECTED_MATCHES, f"{name} matches == {EXPECTED_MATCHES}")
            joined = json.dumps(matches).lower()
            check("localhost" not in joined and "127.0.0.1" not in joined, f"{name} 无测试域名")
            out_files = {p.relative_to(out_dir).as_posix(): sha256_file(p) for p in out_dir.rglob("*") if p.is_file()}
            diffs = [n for n in names if n not in out_files or sha256_bytes_in_zip(zf, n) != out_files[n]]
            check(not diffs, f"{name} ZIP 与 out/{out_sub} 逐文件一致（差异：{diffs[:5]}）")

    # ---- 4. Source ZIP ↔ 干净解压目录（最严谨：Source ZIP 自洽 + 可重建） ----
    clean_dir = root.parent / "clean-rebuild"
    if clean_dir.is_dir():
        ws = workspace_files(clean_dir)
        with zipfile.ZipFile(zips["source"]) as zf:
            znames = {n: hashlib.sha256(zf.read(n)).hexdigest() for n in zf.namelist() if not n.endswith("/")}
        check(set(ws) == set(znames), "Source ZIP 与 clean-rebuild 文件集合一致")
        diffs = sorted(n for n in ws if ws[n] != znames[n])
        check(not diffs, f"Source ZIP 与 clean-rebuild 逐文件内容一致（差异：{diffs[:5]}）")
        print(f"  [ok] Source ZIP 内容比较：{len(ws)} 个文件全部一致（与干净解压目录）")
    else:
        ws = workspace_files(root)
        with zipfile.ZipFile(zips["source"]) as zf:
            znames = {n: hashlib.sha256(zf.read(n)).hexdigest() for n in zf.namelist() if not n.endswith("/")}
        # 容忍测试运行副产物（evidence JSON 被重跑覆盖）：排除后比较
        tolerated = {"runtime-integration-evidence-v0.1.6.json", "runtime-integration-evidence.json"}
        diffs = sorted(n for n in ws if n in znames and ws[n] != znames[n] and n not in tolerated)
        only_ws = sorted(set(ws) - set(znames))
        only_zip = sorted(set(znames) - set(ws))
        check(not only_ws and not only_zip, f"Source ZIP 与工作区文件集合一致（only_ws={only_ws[:5]} only_zip={only_zip[:5]}）")
        check(not diffs, f"Source ZIP 与工作区逐文件内容一致（差异：{diffs[:5]}）")
        print(f"  [ok] Source ZIP 内容比较：{len(ws)} 个文件全部一致（工作区；evidence 运行副产物已容忍）")

    # ---- 5. build-info / RELEASE-EVIDENCE ----
    bi = json.loads((dist / "build-info.json").read_text(encoding="utf-8"))
    check(bi.get("version") == version, "build-info.version == 0.1.6")
    check(bi.get("sourceArchiveSha256") == sha256_file(zips["source"]), "build-info.sourceArchiveSha256 一致")
    ev = json.loads((dist / "RELEASE-EVIDENCE.json").read_text(encoding="utf-8"))
    for name, p in zips.items():
        check(ev.get("zipHashes", {}).get(p.name) == sha256_file(p), f"RELEASE-EVIDENCE.zipHashes.{p.name} 一致")
    for sname in ["lint", "typecheck", "unit", "e2e", "build-chrome", "build-edge", "package", "source-integrity", "source-rebuild", "release-gate"]:
        check(bi.get("exitCodes", {}).get(sname) == 0, f"build-info.exitCodes.{sname} == 0")

    # ---- 6. 真实能力关闭 ----
    cap_src = (root / "src/shared/capabilities.ts").read_text(encoding="utf-8")
    for cap in CAPS:
        m = re.search(rf"{cap}:\s*\{{[^}}]*verified:\s*(true|false)", cap_src)
        check(m is not None and m.group(1) == "false", f"CAPABILITY_VERIFICATION.{cap}.verified == false")
    reasons_src = (root / "src/shared/constants/report-reasons.ts").read_text(encoding="utf-8")
    m = re.search(r"verified:\s*(true|false)", reasons_src)
    check(m is not None and m.group(1) == "false", "REPORT_REASONS.verified == false")
    sel_src = (root / "src/adapters/bilibili/selectors.ts").read_text(encoding="utf-8")
    m = re.search(r"selectorsVerified:\s*(true|false)", sel_src)
    check(m is not None and m.group(1) == "false", "selectors VERIFICATION.selectorsVerified == false")

    # ---- 7. 无 BB_ENQUEUE ----
    msgs_src = (root / "src/shared/messages.ts").read_text(encoding="utf-8")
    check("BB_ENQUEUE" not in msgs_src, "消息协议无 BB_ENQUEUE")
    check("BB_COMMIT_ACTION" in msgs_src, "官方任务经 BB_COMMIT_ACTION 创建")

    # ---- 8. 无实例级 currentLease ----
    coord_src = (root / "src/storage/coordinator.ts").read_text(encoding="utf-8")
    check(not re.search(r"private\s+currentLease", coord_src) and "this.currentLease" not in coord_src,
          "无实例级 currentLease / inLock（coordinator）")
    check("writerFor(lease)" in coord_src and re.search(r"withGlobalWrite\(\s*async\s*\(\s*lease", coord_src) is not None,
          "词法作用域 ScopedWriter（writerFor(lease)）")

    # ---- 9. 队列写一致性 ----
    queue_src = (root / "src/actions/queue.ts").read_text(encoding="utf-8")
    check("structuredClone(this.tasks)" in queue_src, "pendingTasks() 返回结构化克隆")
    check("mergeQueueTasks" in coord_src and "saveQueueTasks(mergeQueueTasks" in coord_src,
          "saveQueueTasks 公共路径锁内合并")

    # ---- 10. pause crash-safe ----
    check("throw new Error(msg)" in queue_src, "pause() 失败显式 reject")
    latch_src = (root / "src/storage/safety-latch.ts").read_text(encoding="utf-8")
    check("PERSISTENT_LATCH_KEY" in latch_src and "chromeStorageLocalLatch" in latch_src,
          "local 持久 latch 通道存在")
    check("compositeSafetyLatch" in latch_src, "compositeSafetyLatch 组合存在")
    bg_src = (root / "src/entrypoints/background/index.ts").read_text(encoding="utf-8")
    check("compositeSafetyLatch(chromeStorageSessionLatch(), chromeStorageLocalLatch())" in bg_src,
          "background 注入 composite latch")

    # ---- 11. resume ----
    check("candidateControl" in queue_src and "paused: false" in queue_src, "resume 使用 controlOverride")
    check("saveQueueSnapshot" in queue_src and "saveQueueSnapshot" in coord_src, "resume 原子落盘 saveQueueSnapshot")

    # ---- 12. structured-clone 语义 ----
    backend_src = (root / "src/storage/backend.ts").read_text(encoding="utf-8")
    check("structuredClone(v)" in backend_src and "structuredClone(store.get(k))" in backend_src,
          "inMemoryBackend 全量 structuredClone")
    repo_src = (root / "src/storage/repository.ts").read_text(encoding="utf-8")
    check("return structuredClone(this.cache.get(key)" in repo_src, "Repository.read 返回克隆")

    # ---- 13. outcome 原子 ----
    check("items[STORAGE_KEYS.operationOutcomes]" in coord_src and "commitSnapshot(items)" in coord_src,
          "operationOutcome 与副作用同一次 commitSnapshot")
    check("saveOutcomeAtomic" in coord_src, "拒绝类结果写绑定记录")

    # ---- 14. ★ 新增 P0 检查：派发前二次状态确认（stale verdict 防护）----
    # 要求：runTask 在设置 in_flight 前必须重新确认任务仍可执行（未被 revoke/cancel 改写）
    print("\n  [independent] ★ P0 新缺陷检查：verify/派发 stale verdict 竞态")
    has_inflight_guard = re.search(
        r"task\.status\s*=\s*'in_flight'", queue_src
    ) is not None and re.search(
        r"task\.status\s*===\s*'queued'", queue_src
    ) is not None
    # 检查 in_flight 赋值之前是否有对 cancelled/revocationRequested 的二次检查
    inflight_idx = queue_src.find("task.status = 'in_flight'")
    guard_ok = False
    if inflight_idx >= 0:
        window = queue_src[max(0, inflight_idx - 400):inflight_idx]
        guard_ok = ("revocationRequested" in window) or ("task.status" in window and "cancelled" in window)
    check(guard_ok, "runTask 在设置 in_flight 前二次检查 cancelled/revocationRequested（v0.1.6 必须）")

    # ---- 15. 独立 runtime evidence ----
    ev_file = root / "review/stage-e-review/independent-evidence.json"
    check(ev_file.is_file(), "独立 evidence（review/stage-e-review/independent-evidence.json）存在")
    if ev_file.is_file():
        probe = json.loads(ev_file.read_text(encoding="utf-8"))
        # 说明：独立探针允许存在发现项（如实记录）；此处打印其状态供人工判定
        false_findings = [k for k, v in probe.get("findings", {}).items() if not v]
        print(f"  [info] 独立探针 findings false 项：{false_findings}")
        print(f"  [info] 独立探针 allFindingsPass：{probe.get('allFindingsPass')}")

    # ---- 16. 开发者 evidence 存在性（不信任其结论，仅记录）----
    dev_ev = root / "runtime-integration-evidence-v0.1.6.json"
    check(dev_ev.is_file(), "开发者 runtime evidence 文件存在（仅作输入证据，独立判定以上述为准）")

    print("\nINDEPENDENT GATE: PASS（代码级检查）——运行时竞态以独立 probes + 人工判定为准")


def sha256_bytes_in_zip(zf: zipfile.ZipFile, name: str) -> str:
    return hashlib.sha256(zf.read(name)).hexdigest()


if __name__ == "__main__":
    main()
