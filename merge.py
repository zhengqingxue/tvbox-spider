#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
merge.py —— 从多个 OmniBox-Spider 仓库拉取 spider 文件，
保留原始分类目录结构，智能去重合并，自动生成分类路由表。

去重规则（按完整相对路径 + MD5）：
  - 同路径 + 同 MD5   → 保留 1 份 🟢
  - 同路径 + 不同 MD5 → 第 1 份原名，后续 _1 _2 后缀 🔵
  - 不同路径          → 全部保留 🟡

输出：
  merged/            合并后的 spider 文件（保留分类目录）
  merged/all_spiders.json  分类路由表（OmniBox 一键导入）
  merged/README.md    人类可读的 spider 清单
"""
import os, sys, json, hashlib, shutil, subprocess, tempfile, re
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
BRANCH = None          # None=自动探测，或硬编码 "main"

# 要保留的 spider 文件扩展名
SPIDER_EXTS = {".js", ".py"}
# 要保留的配置文件扩展名（分类路由表等）
CONFIG_EXTS = {".json"}
# 要丢弃的文件（README / test / 拦截器 / 模板 / 定时任务 / .github 等）
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
    """判断一个文件要不要保留"""
    parts = Path(rel_path).parts
    # 跳过大写目录
    for p in parts:
        if p in SKIP_DIRS or p.startswith("."):
            return False
    ext = Path(rel_path).suffix.lower()
    # spider 文件必须有 @name（排除 test/无效的）
    if ext in SPIDER_EXTS:
        return True
    if ext in CONFIG_EXTS:
        # 只保留分类路由表（包含数字 key 如 '1','2'...的 json）
        if Path(rel_path).name in ("package.json", "package-lock.json", "sync.yml"):
            return False
        return True
    return False

def extract_spider_name(content, filename):
    """从 .js/.py 提取 @name，如果没有就用文件名"""
    # JS: // @name xxx
    m = re.search(r'//\s*@name\s*(.+)', content)
    if m:
        return m.group(1).strip()
    # Python: # @name xxx
    m = re.search(r'#\s*@name\s*(.+)', content)
    if m:
        return m.group(1).strip()
    return Path(filename).stem

def top_category(rel_path):
    """取第一级子目录作为分类（影视/短剧/直播/...）"""
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

def main():
    print("=" * 60)
    print("OmniBox-Spider 智能合并工具 v2")
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

    # ========== 2. 按相对路径分组去重 ==========
    # full_rel_path -> [(md5, repo, abs_path), ...]
    buckets = {}
    for repo, files in all_files_by_repo.items():
        for rel, abs_path in files:
            md5 = md5_of_file(abs_path)
            buckets.setdefault(rel, []).append({
                "md5": md5, "repo": repo, "abs_path": abs_path, "rel": rel,
            })

    # ========== 3. 合并输出 ==========
    print(f"\n{'='*60}")
    print(f"合并结果 ({total_repos} 个源仓库, {original_count} 个原始文件)")
    print(f"{'='*60}")

    stats = {"copied": 0, "dedup": 0, "renamed": 0}
    spider_registry = {}  # top_cat -> [ {name, file, source, ext}, ... ]

    for rel, entries in sorted(buckets.items()):
        md5_groups = {}
        for e in entries:
            md5_groups.setdefault(e["md5"], []).append(e)

        unique_md5s = list(md5_groups.keys())
        top_cat = top_category(rel)
        ext = Path(rel).suffix.lower()

        if len(unique_md5s) == 1:
            # 所有仓库里这个路径的文件内容都一样 → 只保留一份原名
            src = md5_groups[unique_md5s[0]][0]["abs_path"]
            dest_path = OUT / rel
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest_path)
            stats["copied"] += 1
            stats["dedup"] += len(entries) - 1
            repos = set(e["repo"] for e in entries)
            if len(entries) > 1:
                print(f"  🟢 {rel}  ×{len(entries)} (相同内容,来自 {','.join(sorted(repos))})")
            else:
                print(f"  🟡 {rel}")
            # 记录 spider 信息
            if ext in SPIDER_EXTS:
                try:
                    content = src.read_text(encoding='utf-8', errors='replace')
                    name = extract_spider_name(content, rel)
                    spider_registry.setdefault(top_cat, []).append({
                        "name": name, "file": rel, "source": "|".join(sorted(repos)),
                        "ext": ext, "size": src.stat().st_size,
                    })
                except:
                    pass
        else:
            # 同路径不同内容 → 第一个原名, 后续 _1 _2
            for idx, md5 in enumerate(unique_md5s):
                group = md5_groups[md5]
                src = group[0]["abs_path"]
                if idx == 0:
                    dest_path = OUT / rel
                    out_rel = rel
                else:
                    stem = Path(rel).stem
                    suffix = Path(rel).suffix
                    parent = Path(rel).parent
                    out_rel = str(parent / f"{stem}_{idx}{suffix}") if str(parent) != '.' else f"{stem}_{idx}{suffix}"
                    dest_path = OUT / out_rel
                    stats["renamed"] += 1
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest_path)
                stats["copied"] += 1
                repos = set(e["repo"] for e in group)
                label = f"🔵 {out_rel}" if idx > 0 else f"🔵 {out_rel} (不同版本)"
                print(f"  {label}  (来自 {','.join(sorted(repos))})")
                if ext in SPIDER_EXTS:
                    try:
                        content = src.read_text(encoding='utf-8', errors='replace')
                        name = extract_spider_name(content, out_rel)
                        spider_registry.setdefault(top_cat, []).append({
                            "name": name, "file": out_rel, "source": "|".join(sorted(repos)),
                            "ext": ext, "size": src.stat().st_size,
                        })
                    except:
                        pass

    # ========== 4. 生成聚合入口 JSON ==========
    print(f"\n{'='*60}")
    print("生成聚合入口")
    print(f"{'='*60}")

    # all_spiders.json — OmniBox 分类路由表格式
    all_spiders = {}
    cat_id_map = {}  # 分类名 -> 数字 key
    cat_counter = 1

    for cat in sorted(spider_registry.keys()):
        cat_id_map[cat] = str(cat_counter)
        cat_counter += 1
        # 每个分类下的 spider 列表
        all_spiders[str(cat_id_map[cat])] = spider_registry[cat]

    # 额外加元信息
    all_spiders["_meta"] = {
        "generated": tempfile.gettempdir() and "auto",
        "total_spiders": sum(len(v) for k, v in all_spiders.items() if not k.startswith("_")),
        "categories": {cat: cat_id for cat, cat_id in cat_id_map.items()},
    }

    meta_path = OUT / "all_spiders.json"
    meta_path.write_text(json.dumps(all_spiders, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  ✅ all_spiders.json — {meta_path.stat().st_size//1024}KB, {all_spiders['_meta']['total_spiders']} 个 spider, {len(cat_id_map)} 个分类")

    # README.md — 人类可读清单
    readme_lines = [
        "# OmniBox-Spider 合并清单",
        "",
        f"自动生成于 {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M')} UTC",
        f"源仓库: {', '.join(u.rstrip('/').rsplit('/',1)[-2] for u in SOURCE_REPOS)}",
        f"",
        f"## 统计",
        f"- 原始文件: {original_count}",
        f"- 合并后文件: {stats['copied']}",
        f"- 去重: {stats['dedup']}",
        f"- 不同版本改名: {stats['renamed']}",
        f"- Spider 数量: {all_spiders['_meta']['total_spiders']}",
        f"- 分类数: {len(cat_id_map)}",
        f"",
    ]
    for cat, entries in sorted(spider_registry.items()):
        cat_id = cat_id_map[cat]
        readme_lines.append(f"\n## {cat} ({len(entries)} 个)")
        for s in sorted(entries, key=lambda x: x["name"]):
            sz = f"{s['size']//1024}KB" if s['size'] > 1024 else f"{s['size']}B"
            readme_lines.append(f"- {s['name']} — `{s['file']}` ({sz}, {s['source']})")

    readme_path = OUT / "README.md"
    readme_path.write_text("\n".join(readme_lines), encoding="utf-8")
    print(f"  ✅ README.md")

    # ========== 5. 总结 ==========
    print(f"\n{'='*60}")
    print(f"📊 最终总结")
    print(f"{'='*60}")
    print(f"  原始文件数:   {original_count}")
    print(f"  合并后文件数: {stats['copied']}")
    print(f"  去重(相同):   {stats['dedup']}")
    print(f"  版本改名:     {stats['renamed']}")
    print(f"  Spider 总数:  {all_spiders['_meta']['total_spiders']}")
    print(f"  分类目录数:   {len(cat_id_map)}")
    print(f"\n📁 目录结构:")
    for cat in sorted(cat_id_map.keys()):
        n = len(spider_registry[cat])
        print(f"  {cat}/  ({n} 个 spider)")
    print(f"\n✅ 合并完成 → {OUT}")

    shutil.rmtree(tmp_root, ignore_errors=True)

if __name__ == "__main__":
    main()
