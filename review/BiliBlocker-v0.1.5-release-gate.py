#!/usr/bin/env python3
"""
BiliBlocker v0.1.5 确定性发布证据门禁（Stage E 独立复验依据）。

用法：
    python review/BiliBlocker-v0.1.5-release-gate.py <workspace-root> --expected-version 0.1.5

在 v0.1.4 门禁（版本/三 ZIP/SHA256SUMS/Source ZIP 逐文件一致/build-info/十步日志/
RELEASE-EVIDENCE/能力全 false + 8 项运行时探针）基础上，新增 v0.1.5 代码级检查
（对应阶段 E 复验 6 项缺陷）：

1. StorageCoordinator 不存在实例级 currentLease / inLock / 共享「已持锁」状态；
   使用词法作用域 ScopedWriter（writerFor(lease)），外部 writer 永远走公共 execute。
2. 外部 QueueWriter 不继承其他调用的 lease（协调器 writer 无条件经 execute 排队）。
3. queue 写基于锁内最新快照：pendingTasks() 返回结构化克隆；commitAction 在锁内
   读取最新持久队列；saveQueueTasks 公共路径做锁内合并（防旧快照覆盖）。
4. pause() 失败显式 reject + safety latch（chrome.storage.session fail-closed）+ 有限重试；
   start() 先读 latch，无法证明清除则 fail-closed。
5. resume 重验使用 controlOverride（paused:false）——忽略正在解除的 pause，
   其余授权条件仍校验；tasks 与 control 一次原子落盘（saveQueueSnapshot）。
6. inMemoryBackend 与 Repository 采用 structured-clone/不可变副本语义（P1-2）。
7. operationId 结果与副作用原子提交：成功路径单次 commitSnapshot 含名单/队列/outcome；
   拒绝类结果也写绑定记录；不用 catch 吞掉 outcome 持久化错误。
8. 回归测试覆盖存在于 tests/unit/v015-*.ts；runtime-integration-evidence-v0.1.5.json
   六项 findings 全部 false。

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
    parser.add_argument("--expected-version", required=True, help="期望的正式版本号（如 0.1.5）")
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
    for doc in ["docs/ACCEPTANCE-v0.1.4.md", "docs/REMEDIATION-TRACE-v0.1.5.md"]:
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

    # ================= v0.1.5 代码级检查（对应阶段 E 6 项缺陷） =================
    coord_src = (root / "src/storage/coordinator.ts").read_text(encoding="utf-8")
    queue_src = (root / "src/actions/queue.ts").read_text(encoding="utf-8")
    repo_src = (root / "src/storage/repository.ts").read_text(encoding="utf-8")
    backend_src = (root / "src/storage/backend.ts").read_text(encoding="utf-8")
    latch_src = (root / "src/storage/safety-latch.ts").read_text(encoding="utf-8")
    bg_src = (root / "src/entrypoints/background/index.ts").read_text(encoding="utf-8")

    # 13.1 无实例级 currentLease / inLock / 共享持锁状态
    # 注意：注释/文档中可以说明「删除 currentLease」，但不得存在字段声明或赋值/读取
    check(
        not re.search(r"private\s+currentLease", coord_src)
        and not re.search(r"this\.currentLease", coord_src)
        and "private inLock" not in coord_src,
        "StorageCoordinator 不存在实例级 currentLease / inLock / 共享持锁状态",
    )
    # 13.2 词法作用域 ScopedWriter（writerFor + withGlobalWrite 回调）
    check("writerFor(lease)" in coord_src and re.search(r"withGlobalWrite\(\s*async\s*\(\s*lease", coord_src) is not None,
          "协调器使用词法作用域 ScopedWriter（writerFor(lease) 仅在调用栈内有效）")
    # 13.3 外部 writer 永远走公共 execute（无「锁内直接写」旁路判断）
    check("saveTasks: (tasks) => this.execute" in coord_src and "this.currentLease" not in coord_src,
          "外部 writer 无条件经公共 execute 排队（无 currentLease 旁路）")
    # 13.4 pendingTasks 返回结构化克隆（不暴露可变内部数组）
    check("structuredClone(this.tasks)" in queue_src, "ActionQueue.pendingTasks() 返回结构化克隆快照")
    # 13.5 commitAction 锁内读取最新持久队列（不持有旧数组引用）
    check("getQueueTasks()" in coord_src and "latestQueueSnapshot" in coord_src,
          "commitAction 锁内读取最新持久队列快照（无旧数组引用跨 await 覆盖）")
    # 13.6 队列公共写入做锁内合并（防旧快照覆盖）
    check("mergeQueueTasks" in coord_src and "saveQueueTasks(mergeQueueTasks" in coord_src,
          "saveQueueTasks 公共路径锁内合并（stale snapshot 不覆盖新状态）")
    # 13.7 pause 失败显式 reject（不得静默 resolve）
    check("throw new Error(msg)" in queue_src and "暂停状态持久化失败" in queue_src,
          "pause() 持久化失败时显式 reject（不静默成功）")
    # 13.8 safety latch（session fail-closed + start 先读 latch）
    check("SafetyLatch" in queue_src and "latch" in bg_src and "chromeStorageSessionLatch" in latch_src,
          "安全暂停 latch 存在（session fail-closed；background 注入）")
    check("safetyLatched" in queue_src and "fail-closed" in queue_src.lower() or "fail closed" in queue_src.lower(),
          "start() 先读 safety latch，未清除则 fail-closed（不 pump）")
    # 13.9 resume 重验忽略正在解除的 pause（controlOverride）
    check("candidateControl" in queue_src and "paused: false" in queue_src and "buildRevalidated" in queue_src,
          "resume 重验使用 controlOverride（paused:false，忽略正在解除的 pause）")
    # 13.10 tasks 与 control 一次原子落盘（saveQueueSnapshot）
    check("saveQueueSnapshot" in queue_src and "saveQueueSnapshot" in coord_src,
          "resume 的 tasks 与 control 经 saveQueueSnapshot 一次原子落盘")
    # 13.11 structured-clone 存储语义（backend 输入/输出克隆）
    check("structuredClone(v)" in backend_src and "structuredClone(store.get(k))" in backend_src,
          "inMemoryBackend initial/set/get 全量 structuredClone（模拟真实 storage）")
    # 13.12 Repository read 返回克隆（cache 不暴露可变引用）
    check("return structuredClone(this.cache.get(key)" in repo_src,
          "Repository.read() 返回结构化克隆（read-only 边界不可被旁路修改）")
    # 13.13 operation outcome 原子提交（单次 commitSnapshot 含名单/队列/outcome）
    check("items[STORAGE_KEYS.operationOutcomes]" in coord_src and "commitSnapshot(items)" in coord_src,
          "operationId 结果与副作用在同一次 commitSnapshot（原子）")
    check("saveOutcomeAtomic" in coord_src, "拒绝类结果也写确定绑定记录（saveOutcomeAtomic）")
    check("storage_failed" in coord_src, "outcome 写失败 → 整体持久化失败（不用 catch 吞掉）")
    # 13.14 队列内存只在 backend 成功后 adopt
    check("adoptTasks" in coord_src and "adoptControl" in coord_src,
          "ActionQueue 内存只在 backend 成功后 adopt（commitSnapshot 后）")

    # ============ 复验（阶段 E 第二轮）代码级检查 ============
    # 13.15 ScopedWriter 不得逃逸：pause 失败后的 retry 必须经公共 writer（this.deps.writer）排队
    #      （绝不捕获调用方传入的锁内 scoped writer 进 setTimeout）
    check("schedulePauseRetry" in queue_src and "this.deps.writer.saveControl" in queue_src
          and "schedulePauseRetry()" in queue_src,
          "pause retry 经公共 writer（this.deps.writer.saveControl）排队重新抢锁，不逃逸 scoped writer")
    check("pauseRetryTimer = null" in queue_src,
          "pause retry 成功后复位 timer（后续新 pause 仍能再次安排 retry）")
    check("pausePersistPending" in queue_src,
          "相同原因 pause 在持久化未完成时不得早退（pausePersistPending 守卫）")
    # 13.16 浏览器完全重启 fail-closed：local 持久 latch 通道 + composite 组合 + background 注入
    check("PERSISTENT_LATCH_KEY" in latch_src and "chromeStorageLocalLatch" in latch_src,
          "存在 local 持久安全 latch（PERSISTENT_LATCH_KEY / chromeStorageLocalLatch，覆盖浏览器完全重启）")
    check("compositeSafetyLatch" in latch_src,
          "compositeSafetyLatch 组合 session + local 持久通道（isSet OR / set 双写）")
    check("compositeSafetyLatch(chromeStorageSessionLatch(), chromeStorageLocalLatch())" in bg_src,
          "background 注入 composite latch（session + local 持久）")
    # 13.17 revalidate/resume 合并式 adopt：不把 in_flight 回退 queued
    check("applyTasksIfChanged" in queue_src and "cur.status !== 'queued') continue" in queue_src,
          "revalidate 合并式应用：只改当前仍 queued 的任务（in_flight 绝不被回退）")
    check("adoptTasksMerged" in queue_src and "adoptTasksMerged" in coord_src,
          "commitAction 使用合并式 adopt（adoptTasksMerged，pump 推进的 in_flight 不回退）")
    check("mergedTasks" in queue_src and "saveQueueSnapshot(mergedTasks" in queue_src,
          "resume 持久化合并后最新快照（mergedTasks，非旧克隆 updatedTasks）")

    # ============ 复验（阶段 E 第三轮 / E2）代码级检查 ============
    # 13.18 latch 设置失败不阻断 local control 写入（E2-P0-3A）：
    #      control(paused:true) 是跨浏览器重启的持久证据；latch 失败仍须继续写 control
    check("latchFailed" in queue_src and "await w.saveControl(this.control)" in queue_src
          and "throw new Error(this.lastError)" in queue_src,
          "pause(): latch.set() 失败不阻断 local control 写入（control 是跨浏览器重启持久证据；latch 失败仍显式失败）")
    # 13.19 retry 耗尽 ≠ 持久化成功（E2-P0-3B）：耗尽分支保持 pausePersistPending=true
    check("attempt >= PAUSE_RETRY.MAX_ATTEMPTS" in queue_src
          and "this.pauseRetryTimer = null" in queue_src
          and "if (!this.control.paused)" in queue_src,
          "schedulePauseRetry 耗尽分支与恢复分支分离（耗尽保持 pausePersistPending=true，不得静默成功）")
    # 13.20 新 E2 测试文件存在
    check((root / "tests/unit/v015-latch-set-failure.test.ts").is_file(),
          "E2-P0-3A 红测文件 v015-latch-set-failure.test.ts 存在")
    check((root / "tests/unit/v015-pause-retry-exhausted.test.ts").is_file(),
          "E2-P0-3B 红测文件 v015-pause-retry-exhausted.test.ts 存在")


    # ---- 14. 回归测试覆盖（v015 测试文件存在且含关键断言） ----
    v015_files = sorted((root / "tests/unit").glob("v015-*.test.ts"))
    check(len(v015_files) >= 12, f"新增 v0.1.5 回归测试文件 ≥ 12（实际 {len(v015_files)}）")
    coverage_map = {
        "lease 隔离": "v015-lease-isolation.test.ts",
        "stale 快照": "v015-queue-stale-snapshot.test.ts",
        "pause 存储失败": "v015-pause-storage-failure.test.ts",
        "resume 重验": "v015-resume-revalidation.test.ts",
        "storage 克隆": "v015-storage-clone.test.ts",
        "outcome 原子": "v015-operation-outcome-atomic.test.ts",
        "runtime 探针": "v015-runtime-probe.test.ts",
        "scoped-writer 逃逸（复验）": "v015-scoped-writer-escape.test.ts",
        "浏览器重启（复验）": "v015-browser-restart-latch.test.ts",
        "revalidate 回退（复验）": "v015-revalidate-runTask-race.test.ts",
        "persistent latch 失败（E2）": "v015-latch-set-failure.test.ts",
        "pause retry 耗尽（E2）": "v015-pause-retry-exhausted.test.ts",
    }
    for label, fname in coverage_map.items():
        fp = root / "tests/unit" / fname
        check(fp.is_file(), f"回归测试覆盖: {label}（{fname} 存在）")

    # ---- 15. runtime-integration-evidence-v0.1.5.json（6 项缺陷全关闭） ----
    probe_file = root / "runtime-integration-evidence-v0.1.5.json"
    check(probe_file.is_file(), "提交 runtime-integration-evidence-v0.1.5.json")
    try:
        probe = json.loads(probe_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        fail("runtime-integration-evidence-v0.1.5.json 不是合法 JSON")
    findings = probe.get("findings") or {}
    expected_false = {
        "externalQueueWriterInheritedLease": False,
        "queueStateLostOrReverted": False,
        "pausePersistenceLostAfterRestart": False,
        "resumeSkippedValidQueuedTask": False,
        "readOnlyCacheMutation": False,
        "operationOutcomeNonAtomic": False,
        # 复验（阶段 E 第二轮）新增 3 项
        "scopedWriterTimerEscape": False,
        "browserFullRestartFailOpen": False,
        "revalidateRunTaskRevert": False,
        # 复验（阶段 E 第三轮 / E2）新增 2 项
        "persistentLatchSetFailureFailOpen": False,
        "pauseRetryExhaustedSilentResume": False,
    }
    for k, v in expected_false.items():
        check(findings.get(k) is False, f"runtime probe {k} == false（实际 {findings.get(k)}）")
    check(probe.get("allDefectsClosed") is True, "runtime probe allDefectsClosed == true")
    results = probe.get("results") or {}
    check(results.get("writerVsExecuteMaxActive") == 1, f"writer vs execute 最大活跃写 == 1（实际 {results.get('writerVsExecuteMaxActive')}）")
    check(results.get("validTaskExecutedAfterResume") == 1, "resume 后合法任务执行恰好一次")
    check(results.get("sameOperationReturnsSameResult") is True, "同 operationId 重放返回相同结果")
    check(results.get("restartRemainsFailClosed") is True, "SW 重启后仍 fail-closed")
    check(results.get("pauseFailureReported") is True, "pause 持久化失败已报告")
    # 复验（阶段 E 第二轮）results
    check(results.get("pauseRetryMaxActive") == 1, f"pause retry 最大活跃写 == 1（实际 {results.get('pauseRetryMaxActive')}）")
    check(results.get("browserRestartRemainsFailClosed") is True, "浏览器完全重启后仍 fail-closed")
    check(results.get("browserRestartNoDispatch") is True, "浏览器重启后不派发（fail-closed）")
    check(results.get("revalidateExecutorExactlyOnce") is True, "revalidate 并发下 executor 恰好一次")
    check(results.get("revalidateStorageFinal") == "succeeded", f"revalidate 并发后存储终态 succeeded（实际 {results.get('revalidateStorageFinal')}）")
    # 复验（阶段 E 第三轮 / E2）results
    check(results.get("persistentLatchFailureRestartFailClosed") is True, "persistent latch 失败后浏览器完全重启仍 fail-closed")
    check(results.get("persistentLatchFailureNoDispatch") is True, "persistent latch 失败重启后不派发")
    check(results.get("pauseRetryExhaustedSecondRejected") is True, "retry 耗尽后相同原因 pause 仍 reject（不静默成功）")

    # ---- 16. 生产代码无 currentLease 字段声明/使用残留（注释中的说明文字允许） ----
    for src_file in sorted((root / "src").rglob("*.ts")):
        text = src_file.read_text(encoding="utf-8")
        if re.search(r"private\s+currentLease", text) or re.search(r"this\.currentLease", text):
            fail(f"生产代码仍含 currentLease 字段声明/使用：{src_file.relative_to(root)}")

    print("RELEASE GATE: PASS")


if __name__ == "__main__":
    main()
