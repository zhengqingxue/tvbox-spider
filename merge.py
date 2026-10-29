#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
merge.py —— 从多个公开 OmniBox-Spider 仓库拉取 JSON 接口文件，
按文件名去重合并到输出目录。

规则：
  - 同名文件、内容相同（MD5）→ 只保留 1 份
  - 同名文件、内容不同     → 第 1 份原名，后续 xxx_1.json / xxx_2.json ...
  - 不同名文件             → 全部保留

用法：python merge.py
配置：修改下面 SOURCE_REPOS 列表即可
"""
import os, sys, json, hashlib, shutil, subprocess, tempfile
from pathlib import Path

# ========== 配置区 ==========
SOURCE_REPOS = [
    "https://github.com/wxnlq/OmniBox-Spider",
    "https://github.com/uTiamoO/OmniBox-Spider",
    "https://github.com/xiaohu1949/OmniBox-Spider",
    "https://github.com/MoraGG/OmniBox-Spider",
    "https://github.com/Silent1566/OmniBox-Spider",
]
OUTPUT_DIR = "merged"          # 输出目录（相对于脚本位置）
BRANCH = None                  # None=自动探测 main/master，或硬编码 "main"
# ========== 配置区 ==========

SCRIPT_DIR = Path(__file__).parent.resolve()
OUT = SCRIPT_DIR / OUTPUT_DIR

def run(cmd, cwd=None):
    """跑 shell 命令，失败返回 None"""
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=120)
        return r if r.returncode == 0 else None
    except Exception as e:
        return None

def md5_of_file(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

def find_branch(repo_url):
    """自动探测 main / master 分支"""
    for br in ["main", "master"]:
        if run(["git", "ls-remote", "--heads", repo_url, br]):
            return br
    return None

def clone_repo(repo_url, dest):
    """浅克隆一个仓库，返回 True/False"""
    if (dest).exists():
        shutil.rmtree(dest)
    branch = BRANCH or find_branch(repo_url)
    if not branch:
        print(f"  ❌ 找不到分支 (main/master 都失败)")
        return False
    r = run(["git", "clone", "--depth", "1", "--branch", branch, repo_url, str(dest)])
    if not r:
        print(f"  ❌ clone 失败")
        return False
    return True

def collect_files(root_dir):
    """递归收集所有文件，返回 [(相对路径, 绝对路径)]"""
    root = Path(root_dir)
    result = []
    for f in root.rglob("*"):
        if f.is_file() and not f.name.startswith("."):
            # .git 目录里的忽略
            if ".git" in f.parts:
                continue
            rel = f.relative_to(root)
            result.append((str(rel), f))
    return result

def main():
    print("=" * 60)
    print("OmniBox-Spider 合并工具")
    print("=" * 60)

    # 清理输出目录
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    # 临时目录放 clone 下来的仓库
    tmp_root = Path(tempfile.mkdtemp(prefix="spider_merge_"))
    print(f"\n临时目录: {tmp_root}")

    # ========== 1. clone 所有源仓库 ==========
    all_files_by_repo = {}  # repo_name -> [(rel_path, abs_path)]
    for url in SOURCE_REPOS:
        repo_name = url.rstrip("/").rsplit("/", 1)[-2]  # github.com/USER/REPO -> USER
        dest = tmp_root / repo_name
        print(f"\n📥 [{repo_name}] clone {url}")
        ok = clone_repo(url, dest)
        if not ok:
            print(f"  ⚠️ 跳过 {repo_name}")
            continue
        files = collect_files(dest)
        all_files_by_repo[repo_name] = files
        print(f"  ✅ {len(files)} 个文件")

    total_repos = len(all_files_by_repo)
    if total_repos == 0:
        print("\n❌ 所有仓库都 clone 失败，退出")
        shutil.rmtree(tmp_root, ignore_errors=True)
        sys.exit(1)

    # ========== 2. 按文件名分组 ==========
    # filename -> [(md5, source_repo, abs_path), ...]
    buckets = {}
    for repo, files in all_files_by_repo.items():
        for rel, abs_path in files:
            fname = Path(rel).name  # 只用文件名分组，忽略子目录
            md5 = md5_of_file(abs_path)
            buckets.setdefault(fname, []).append({
                "md5": md5, "repo": repo, "abs_path": abs_path, "rel": rel,
            })

    # ========== 3. 合并逻辑 ==========
    print(f"\n{'='*60}")
    print(f"合并结果 ({total_repos} 个源仓库)")
    print(f"{'='*60}")

    stats = {"total_files": 0, "dedup": 0, "renamed": 0, "unique": 0}
    output_map = {}  # 最终输出文件名 -> (源文件, 来源仓库)

    for fname, entries in sorted(buckets.items()):
        # 按 MD5 分组，相同 MD5 说明文件内容一样
        md5_groups = {}
        for e in entries:
            md5_groups.setdefault(e["md5"], []).append(e)

        unique_md5s = list(md5_groups.keys())
        first_group = md5_groups[unique_md5s[0]]

        if len(unique_md5s) == 1:
            # 所有仓库里这个文件内容都一样 → 保留 1 份原名
            src = first_group[0]["abs_path"]
            shutil.copy2(src, OUT / fname)
            stats["dedup"] += len(entries) - 1
            stats["total_files"] += 1
            output_map[fname] = (src, [e["repo"] for e in entries])
            repos_str = ",".join(sorted(set(e["repo"] for e in entries)))
            if len(entries) > 1:
                print(f"  🟢 {fname}  相同×{len(entries)} (来自 {repos_str})")
            else:
                print(f"  🟡 {fname}  唯一")
        else:
            # 不同内容 → 第一个保留原名，后面加 _1 _2 ...
            sorted_groups = sorted(unique_md5s, key=lambda m: md5_groups[m][0]["repo"])
            for idx, md5 in enumerate(sorted_groups):
                group = md5_groups[md5]
                src = group[0]["abs_path"]
                if idx == 0:
                    out_name = fname
                else:
                    stem = Path(fname).stem
                    suffix = Path(fname).suffix
                    out_name = f"{stem}_{idx}{suffix}"
                    stats["renamed"] += 1
                shutil.copy2(src, OUT / out_name)
                stats["total_files"] += 1
                repos_str = ",".join(sorted(set(e["repo"] for e in group)))
                print(f"  🔵 {out_name}  (来自 {repos_str})")

    stats["unique"] = stats["total_files"] - stats["renamed"]

    # ========== 4. 总结 ==========
    print(f"\n{'='*60}")
    print(f"📊 总结")
    print(f"{'='*60}")
    print(f"  源仓库数:     {total_repos}")
    print(f"  原始文件总数: {sum(len(v) for v in all_files_by_repo.values())}")
    print(f"  输出文件数:   {stats['total_files']}")
    print(f"  去重(相同内容): {stats['dedup']}")
    print(f"  内容不同需改名: {stats['renamed']}")
    print(f"\n✅ 合并完成 → {OUT}")

    # 清理临时目录
    shutil.rmtree(tmp_root, ignore_errors=True)

if __name__ == "__main__":
    main()
