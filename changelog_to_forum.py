#!/usr/bin/env python3
"""Regenerate CHANGELOG_FORUM.html from CHANGELOG.md.

The Torn forum editor is HTML-based, not markdown/BBCode: pasting the markdown
changelog leaves literal ##, -, ** and backticks, and collapses whitespace. This
converts the canonical CHANGELOG.md into paste-ready HTML (version headers as bold
paragraphs, entries as <ul>/<li>, `code` as <code>, **bold** as <strong>, *italic*
as <em>, with &<> escaped). Paste the output via the forum editor's Source Code (</>)
button.

Run from the repo root:  python changelog_to_forum.py
Regenerate whenever CHANGELOG.md changes, same as CHANGELOG_DISCORD.txt.
"""
import re
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "CHANGELOG.md")
DST = os.path.join(ROOT, "CHANGELOG_FORUM.html")


def inline(s):
    # Escape HTML specials FIRST, then apply the markdown -> HTML conversions.
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", s)
    return s


def convert(lines):
    out = []
    state = {"top": False, "li": False, "sub": False}

    def close_sub():
        if state["sub"]:
            out.append("</ul>")
            state["sub"] = False

    def close_li():
        close_sub()
        if state["li"]:
            out.append("</li>")
            state["li"] = False

    def close_top():
        close_li()
        if state["top"]:
            out.append("</ul>")
            state["top"] = False

    for raw in lines:
        line = raw.rstrip("\n")
        if line.startswith("# ") or line.strip() == "---":
            continue
        if line.startswith("## "):
            close_top()
            out.append("<p><strong>" + inline(line[3:].strip()) + "</strong></p>")
            continue
        if re.match(r"^- ", line):
            if not state["top"]:
                out.append("<ul>")
                state["top"] = True
            else:
                close_li()
            out.append("<li>" + inline(line[2:].strip()))
            state["li"] = True
            continue
        if re.match(r"^\s{2,}- ", line):
            if not state["sub"]:
                out.append("<ul>")
                state["sub"] = True
            out.append("<li>" + inline(line.split("- ", 1)[1].strip()) + "</li>")
            continue
        if line.strip() == "":
            continue
        close_top()
        out.append("<p>" + inline(line.strip()) + "</p>")

    close_top()
    return "\n".join(out) + "\n"


def main():
    with open(SRC, encoding="utf-8") as fh:
        html = convert(fh.read().splitlines())
    with open(DST, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("wrote", os.path.basename(DST))


if __name__ == "__main__":
    main()
