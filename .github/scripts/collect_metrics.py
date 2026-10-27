"""Collects the repository's launch metrics into CSV files.

Run by .github/workflows/metrics.yml once a day. GitHub keeps traffic for
14 days only, so every run merges what the API returns into the CSVs under
DATA_DIR: rows for the same date are replaced, never duplicated. See
docs/metrics.md for the columns.

    python collect_metrics.py DATA_DIR

Environment:
    GITHUB_REPOSITORY  owner/name
    TRAFFIC_TOKEN      token with Administration: read (traffic endpoints)
    GITHUB_TOKEN       token for the public endpoints (releases, stars)
    METRICS_API_URL    API base, default https://api.github.com (for tests)
    METRICS_TODAY      YYYY-MM-DD to record under, default today in UTC
"""

import csv
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ.get("METRICS_API_URL", "https://api.github.com").rstrip("/")


def get(path, token):
    req = urllib.request.Request(API + path, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "leeway-metrics",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"GET {path} failed: HTTP {e.code} {e.reason}") from None


def read_rows(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_rows(path, fields, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def replace_date(path, fields, date_field, date, new_rows, sort_key):
    """Drops the rows recorded under `date` and writes `new_rows` in their place."""
    rows = [r for r in read_rows(path) if r[date_field] != date] + new_rows
    rows.sort(key=sort_key)
    write_rows(path, fields, rows)


def collect_traffic(data, repo, token):
    views = get(f"/repos/{repo}/traffic/views?per=day", token)["views"]
    clones = get(f"/repos/{repo}/traffic/clones?per=day", token)["clones"]

    path = os.path.join(data, "traffic.csv")
    fields = ["date", "views", "unique_visitors", "clones", "unique_cloners"]
    by_date = {r["date"]: r for r in read_rows(path)}
    fresh = {}
    for v in views:
        row = fresh.setdefault(v["timestamp"][:10], dict.fromkeys(fields, 0))
        row["views"], row["unique_visitors"] = v["count"], v["uniques"]
    for c in clones:
        row = fresh.setdefault(c["timestamp"][:10], dict.fromkeys(fields, 0))
        row["clones"], row["unique_cloners"] = c["count"], c["uniques"]
    for date, row in fresh.items():
        row["date"] = date
        by_date[date] = row
    write_rows(path, fields, [by_date[d] for d in sorted(by_date)])
    return len(fresh)


def collect_top(data, repo, token, today):
    referrers = get(f"/repos/{repo}/traffic/popular/referrers", token)
    paths = get(f"/repos/{repo}/traffic/popular/paths", token)

    replace_date(
        os.path.join(data, "referrers.csv"),
        ["snapshot_date", "referrer", "count", "uniques"], "snapshot_date", today,
        [{"snapshot_date": today, "referrer": r["referrer"], "count": r["count"],
          "uniques": r["uniques"]} for r in referrers[:10]],
        lambda r: (r["snapshot_date"], -int(r["count"]), r["referrer"]))
    replace_date(
        os.path.join(data, "paths.csv"),
        ["snapshot_date", "path", "title", "count", "uniques"], "snapshot_date", today,
        [{"snapshot_date": today, "path": p["path"], "title": p["title"],
          "count": p["count"], "uniques": p["uniques"]} for p in paths[:10]],
        lambda r: (r["snapshot_date"], -int(r["count"]), r["path"]))
    return len(referrers[:10]), len(paths[:10])


def collect_downloads(data, repo, token, today):
    rows, page = [], 1
    while True:
        releases = get(f"/repos/{repo}/releases?per_page=100&page={page}", token)
        for rel in releases:
            for a in rel["assets"]:
                rows.append({"date": today, "tag": rel["tag_name"], "asset": a["name"],
                             "download_count": a["download_count"]})
        if len(releases) < 100:
            break
        page += 1
    replace_date(os.path.join(data, "downloads.csv"),
                 ["date", "tag", "asset", "download_count"], "date", today, rows,
                 lambda r: (r["date"], r["tag"], r["asset"]))
    return len(rows)


def collect_stars(data, repo, token, today):
    stars = get(f"/repos/{repo}", token)["stargazers_count"]
    replace_date(os.path.join(data, "stars.csv"), ["date", "stars"], "date", today,
                 [{"date": today, "stars": stars}], lambda r: r["date"])
    return stars


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: collect_metrics.py DATA_DIR")
    data = sys.argv[1]
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    traffic_token = os.environ.get("TRAFFIC_TOKEN", "")
    public_token = os.environ.get("GITHUB_TOKEN", "")
    if not repo:
        raise SystemExit("GITHUB_REPOSITORY is not set")
    if not traffic_token:
        raise SystemExit("TRAFFIC_TOKEN is empty: add the repository secret (see docs/metrics.md)")
    if not public_token:
        raise SystemExit("GITHUB_TOKEN is not set")
    today = os.environ.get("METRICS_TODAY") or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")

    os.makedirs(data, exist_ok=True)
    days = collect_traffic(data, repo, traffic_token)
    refs, paths = collect_top(data, repo, traffic_token, today)
    assets = collect_downloads(data, repo, public_token, today)
    stars = collect_stars(data, repo, public_token, today)
    print(f"{today}: traffic {days} days, {refs} referrers, {paths} paths, "
          f"{assets} release assets, {stars} stars")


if __name__ == "__main__":
    main()
