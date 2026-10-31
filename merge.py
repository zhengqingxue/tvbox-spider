#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
merge.py —— 从多个 OmniBox-Spider 仓库拉取 spider 文件，
全局按 MD5 去重（内容一样就是同一个，不管文件名、不管路径、不管哪个仓库），
保留原始分类目录结构。

去重规则：
  - 内容一样（同 MD5）→ 只留 1 份 🟢，挑最干净的文件名
  - 内容不一样        → 都保留 🟡

输出：
  merged/            合并后的 spider 文件（保留原始分类目录）
"""
import os, sys, hashlib, shutil, subprocess, tempfile, re
from pathlib import Path

# ========== 配置区 ==========
SOURCE_REPOS = [
    "https://github.com/wxnlq/OmniBox-Spider",
    "https://github.com/uTiamoO/OmniBox-Spider",
    "https://github.com/xiaohu1949/OmniBox-Spider",
    "https://github.com/MoraGG/OmniBox-Spider",
    "https://github.com/Silent1566/OmniBox-Spider",
]
OUTPUT_DIR = "merged"
BRANCH = None

SPIDER_EXTS = {".js", ".py"}
CONFIG_EXTS = {".json"}
SKIP_DIRS = {".github", ".git", "tests", "模板", "拦截器", "定时任务",
             "已失效待修复", "node_modules"}
# ========== 配置区 ==========

SCRIPT_DIR = Path(__file__).parent.resolve()
OUT = SCRIPT_DIR / OUTPUT_DIR

def run(cmd, cwd=None):
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=120)
        return r if r.returncode == 0 else None
    except:
        return None

def md5_of_file(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

def find_branch(repo_url):
    for br in ["main", "master"]:
        if run(["git", "ls-remote", "--heads", repo_url, br]):
            return br
    return None

def clone_repo(repo_url, dest):
    if dest.exists():
        shutil.rmtree(dest)
    branch = BRANCH or find_branch(repo_url)
    if not branch:
        print(f"  ❌ 找不到分支")
        return False
    r = run(["git", "clone", "--depth", "1", "--branch", branch, repo_url, str(dest)])
    if not r:
        print(f"  ❌ clone 失败")
        return False
    return True

def should_keep(rel_path):
    parts = Path(rel_path).parts
    for p in parts:
        if p in SKIP_DIRS or p.startswith("."):
            return False
    ext = Path(rel_path).suffix.lower()
    if ext in SPIDER_EXTS:
        return True
    if ext in CONFIG_EXTS:
        if Path(rel_path).name in ("package.json", "package-lock.json", "sync.yml"):
            return False
        return True
    return False

def top_category(rel_path):
    parts = Path(rel_path).parts
    if len(parts) >= 2:
        return parts[0]
    return "根目录"

def collect_files(root_dir):
    root = Path(root_dir)
    result = []
    for f in root.rglob("*"):
        if f.is_file() and not f.name.startswith("."):
            if ".git" in f.parts:
                continue
            rel = f.relative_to(root)
            if should_keep(str(rel)):
                result.append((str(rel), f))
    return result

def clean_name(name):
    """清洗文件名，用于挑选最干净的那份当代表"""
    stem = Path(name).stem
    # 去 _1 _2 _3 后缀
    stem = re.sub(r'_\d+$', '', stem)
    # 去 [xxx] 方括号
    stem = re.sub(r'\[.*?\]', '', stem)
    # 去 -xxx- 前后缀
    stem = stem.strip('- ')
    # 去 emoji 前后缀影响，保留核心词
    return stem

def name_score(e):
    """文件名打分，越低越好（越干净越短）"""
    fn = e["fname"]
    clean = clean_name(fn)
    return (len(clean), clean)

def main():
    print("=" * 60)
    print("OmniBox-Spider 智能合并工具 v3 (MD5 全局去重)")
    print("=" * 60)

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    tmp_root = Path(tempfile.mkdtemp(prefix="spider_merge_"))
    print(f"\n临时目录: {tmp_root}")

    # ========== 1. clone ==========
    all_files_by_repo = {}
    for url in SOURCE_REPOS:
        repo_name = url.rstrip("/").rsplit("/", 1)[-2]
        dest = tmp_root / repo_name
        print(f"\n📥 [{repo_name}] clone")
        ok = clone_repo(url, dest)
        if not ok:
            print(f"  ⚠️ 跳过")
            continue
        files = collect_files(dest)
        all_files_by_repo[repo_name] = files
        print(f"  ✅ {len(files)} 个有效文件 (过滤后)")

    total_repos = len(all_files_by_repo)
    if total_repos == 0:
        print("\n❌ 所有仓库 clone 失败")
        sys.exit(1)

    original_count = sum(len(v) for v in all_files_by_repo.values())

    # ========== 2. 全局按 MD5 分桶（内容一样就是同一个） ==========
    # md5 -> [{repo, abs_path, rel, fname}, ...]
    buckets = {}
    for repo, files in all_files_by_repo.items():
        for rel, abs_path in files:
            md5 = md5_of_file(abs_path)
            fname = Path(rel).name
            buckets.setdefault(md5, []).append({
                "md5": md5, "repo": repo, "abs_path": abs_path,
                "rel": rel, "fname": fname,
            })

    # ========== 3. 合并输出 ==========
    print(f"\n{'='*60}")
    print(f"合并结果 ({total_repos} 个源仓库, {original_count} 个原始文件)")
    print(f"{'='*60}")

    stats = {"copied": 0, "dedup": 0}
    dir_counts = {}

    for md5, entries in sorted(buckets.items()):
        # 从 MD5 相同的一堆里挑一个最干净的当代表
        entries_sorted = sorted(entries, key=name_score)
        winner = entries_sorted[0]

        out_rel = winner["rel"]
        src = winner["abs_path"]
        dest_path = OUT / out_rel
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest_path)

        stats["copied"] += 1
        stats["dedup"] += len(entries) - 1
        top_cat = top_category(out_rel)
        dir_counts[top_cat] = dir_counts.get(top_cat, 0) + 1

        all_names = set(e["fname"] for e in entries)
        repos = set(e["repo"] for e in entries)
        cats = set(top_category(e["rel"]) for e in entries)

        if len(entries) == 1:
            print(f"  🟡 {out_rel}")
        elif len(all_names) == 1:
            print(f"  🟢 {out_rel}  ×{len(entries)} (跨{len(cats)}分类,来自{','.join(sorted(repos))})")
        else:
            # 内容一样但文件名不一样 —— 典型的 "木偶.js" vs "木偶_1.js" vs "木偶[v2].js"
            names_str = ",".join(sorted(all_names))
            print(f"  🟢 {out_rel}  ×{len(entries)} (同内容,不同文件名: {names_str})")

    # ========== 4. 总结 ==========
    print(f"\n{'='*60}")
    print(f"📊 最终总结")
    print(f"{'='*60}")
    print(f"  原始文件数:    {original_count}")
    print(f"  合并后文件数:  {stats['copied']}")
    print(f"  MD5 去重数量:  {stats['dedup']}")
    print(f"  压缩率:        {round(stats['dedup']/original_count*100,1)}%")
    print(f"\n📁 分类目录:")
    for cat, n in sorted(dir_counts.items()):
        print(f"  {cat}/  ({n} 个文件)")
    print(f"\n✅ 合并完成 → {OUT}")

    shutil.rmtree(tmp_root, ignore_errors=True)

if __name__ == "__main__":
    main()
