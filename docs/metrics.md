# Launch metrics

`.github/workflows/metrics.yml` runs every day at 00:00 UTC (09:00 KST), and can be run by hand from the Actions tab. It writes `data/*.csv` on the `metrics` branch, creating the branch on its first run. Nothing is sent anywhere but the GitHub API.

## Secret

| Secret | Value |
|---|---|
| `TRAFFIC_TOKEN` | Fine-grained personal access token, repository access: this repository only, permission **Administration: Read-only** (Metadata: Read-only is added with it) |

The traffic API does not accept the workflow's own `GITHUB_TOKEN`, so the token is used for the four traffic endpoints only. Releases and stars are read with `GITHUB_TOKEN`, which also pushes the `metrics` branch. If the secret is missing or expires, the run fails.

## CSV files

All dates are UTC days, the unit GitHub counts traffic in. Running twice on one day replaces that day's rows.

| File | Columns | Notes |
|---|---|---|
| `traffic.csv` | `date, views, unique_visitors, clones, unique_cloners` | One row per day. Each run rewrites the last 14 days with GitHub's latest numbers; today's row is partial until the next run. |
| `referrers.csv` | `snapshot_date, referrer, count, uniques` | Top 10 sites people came from, as of that day. Counts cover the 14 days before it. |
| `paths.csv` | `snapshot_date, path, title, count, uniques` | Top 10 pages viewed in the repository, as of that day, over the same 14 days. |
| `downloads.csv` | `date, tag, asset, download_count` | Every release asset's total downloads so far, recorded each day. |
| `stars.csv` | `date, stars` | Star count on that day. |
