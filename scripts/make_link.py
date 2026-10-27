#!/usr/bin/env python3
"""Build a promotion link with UTM tags. Rules: docs/tracking-links.md

    python scripts/make_link.py <source> <medium> <target> [--campaign launch_YYYYMM]
    python scripts/make_link.py --list

Standard library only. Prints the final URL to stdout; rejected values exit 2.
"""
import argparse
import datetime
import re
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Change the store link here only.
STORE_URL = "https://chromewebstore.google.com/detail/dlifmhanolkjflblnofiifgkffhkpgga"

TARGETS = {
    "store": STORE_URL,
    "repo": "https://github.com/donasman/leeway",
    "releases": "https://github.com/donasman/leeway/releases/latest",
}

# utm_source: where the link is posted. Add new places here and in docs/tracking-links.md.
SOURCES = ["geeknews", "reddit_claudeai", "disquiet", "study", "github_readme"]

# utm_medium: what kind of post it is.
MEDIUMS = ["post", "comment", "readme", "dm"]

NAME_RE = re.compile(r"^[a-z_]+$")
CAMPAIGN_RE = re.compile(r"^launch_(\d{4})(\d{2})$")


class LinkError(ValueError):
    pass


def check_name(kind, value, allowed):
    if not NAME_RE.match(value):
        raise LinkError(f"{kind} {value!r} is not allowed (lowercase letters and _ only). "
                        f"allowed: {', '.join(sorted(allowed))}")
    if value not in allowed:
        raise LinkError(f"{kind} {value!r} is not in the list. allowed: {', '.join(sorted(allowed))}")


def check_campaign(value):
    m = CAMPAIGN_RE.match(value)
    if not m or not 1 <= int(m.group(2)) <= 12:
        raise LinkError(f"utm_campaign {value!r} must be launch_YYYYMM (e.g. launch_202610)")


def default_campaign(today=None):
    today = today or datetime.date.today()
    return f"launch_{today:%Y%m}"


def make_link(source, medium, target, campaign=None):
    check_name("utm_source", source, SOURCES)
    check_name("utm_medium", medium, MEDIUMS)
    check_name("target", target, TARGETS)
    campaign = campaign or default_campaign()
    check_campaign(campaign)

    parts = urlsplit(TARGETS[target])
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not k.startswith("utm_")]
    query += [("utm_source", source), ("utm_medium", medium), ("utm_campaign", campaign)]
    return urlunsplit(parts._replace(query=urlencode(query)))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build a promotion link with UTM tags (docs/tracking-links.md).")
    parser.add_argument("source", nargs="?", help="utm_source: " + ", ".join(SOURCES))
    parser.add_argument("medium", nargs="?", help="utm_medium: " + ", ".join(MEDIUMS))
    parser.add_argument("target", nargs="?", help="link target: " + ", ".join(TARGETS))
    parser.add_argument("--campaign", help="utm_campaign, launch_YYYYMM (default: this month)")
    parser.add_argument("--list", action="store_true", help="print allowed values and exit")
    args = parser.parse_args(argv)

    if args.list:
        print("source:  " + ", ".join(SOURCES))
        print("medium:  " + ", ".join(MEDIUMS))
        for name, url in TARGETS.items():
            print(f"target:  {name:<9} {url}")
        return 0
    if not (args.source and args.medium and args.target):
        parser.error("source, medium and target are required")

    try:
        print(make_link(args.source, args.medium, args.target, args.campaign))
    except LinkError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
