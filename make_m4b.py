#!/usr/bin/env python3
"""Turn an OdioFile bundle folder (audiobook.mp3 + table-of-contents.csv) into a chaptered .m4b.

Usage:
    python3 make_m4b.py "<bundle folder>" [--title T] [--author A] [--bitrate 64k] [--cover cover.jpg] [-o out.m4b]

Requires ffmpeg and ffprobe: either on PATH (brew install ffmpeg) or sitting next to this script (or next to its folder).
"""
import argparse
import csv
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"


def find_tool(name):
    """Return ffmpeg/ffprobe from PATH, else a copy next to this script, else one in the folder
    that contains this project folder (which survives replacing the project folder on update)."""
    found = shutil.which(name)
    if found:
        return found
    for folder in (HERE, HERE.parent):
        for candidate in (folder / name, folder / (name + ".exe")):
            if candidate.is_file():
                return str(candidate)
    return None


def parse_timestamp(text):
    """'32', '00:32', '1:01:01' (seconds / MM:SS / H:MM:SS) -> seconds."""
    parts = [int(p) for p in text.strip().split(":")]
    if not 1 <= len(parts) <= 3:
        raise ValueError(text)
    seconds = 0
    for p in parts:
        seconds = seconds * 60 + p
    return seconds


def read_chapters(csv_path):
    chapters = []
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            title = (row.get("Title") or "").strip()
            stamp = (row.get("Timestamp") or "").strip()
            if not title or not stamp:
                continue
            try:
                chapters.append((title, parse_timestamp(stamp)))
            except ValueError:
                sys.exit(f"Can't read timestamp {stamp!r} for chapter {title!r} in {csv_path.name}")
    return chapters


def duration_seconds(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


def meta_escape(text):
    return re.sub(r"([=;#\\])", r"\\\1", text).replace("\n", "\\\n")


def build_metadata(chapters, total_seconds, title, author):
    lines = [";FFMETADATA1", f"title={meta_escape(title)}", f"album={meta_escape(title)}", "genre=Audiobook", "media_type=2"]
    if author:
        lines += [f"artist={meta_escape(author)}", f"album_artist={meta_escape(author)}"]

    total_ms = int(round(total_seconds * 1000))
    starts = [(t, int(s * 1000)) for t, s in chapters]
    if starts and starts[0][1] > 500:
        starts.insert(0, ("Opening", 0))

    written = 0
    for i, (name, start) in enumerate(starts):
        end = starts[i + 1][1] if i + 1 < len(starts) else total_ms
        if start >= total_ms:
            print(f"  skipping {name!r}: starts at/after the end of the audio", file=sys.stderr)
            continue
        if end <= start:
            print(f"  skipping {name!r}: zero or negative length", file=sys.stderr)
            continue
        lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={start}", f"END={end}", f"title={meta_escape(name)}"]
        written += 1
    return "\n".join(lines) + "\n", written


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path, help="bundle folder containing audiobook.mp3 and table-of-contents.csv")
    ap.add_argument("--title", help="book title (default: the title saved in book.json, else the 0:00 chapter)")
    ap.add_argument("--author", help="author name")
    ap.add_argument("--bitrate", default="64k", help="AAC bitrate (default 64k, fine for speech)")
    ap.add_argument("--cover", type=Path, help="cover image to embed (default: cover.jpg/png/webp in the folder)")
    ap.add_argument("-o", "--output", type=Path, help="output file (default: <title>.m4b in the folder)")
    args = ap.parse_args()

    global FFMPEG, FFPROBE
    FFMPEG, FFPROBE = find_tool("ffmpeg"), find_tool("ffprobe")
    for name, path in (("ffmpeg", FFMPEG), ("ffprobe", FFPROBE)):
        if not path:
            sys.exit(f"{name} not found. Put the {name} file next to the OdioFile folder (or inside it), "
                     "or install it (brew install ffmpeg).")

    mp3 = args.folder / "audiobook.mp3"
    csv_path = args.folder / "table-of-contents.csv"
    if not mp3.exists():
        if (args.folder / "Chapters").is_dir():
            sys.exit("This folder was built with 'Split into one MP3 per chapter', so it has chapter files but no "
                     "merged audiobook.mp3 to convert. Build the book again without the split option to make an M4B.")
        sys.exit(f"Missing {mp3}")
    chapters = read_chapters(csv_path) if csv_path.exists() else []
    if not chapters:
        print("No chapters found — building the M4B without chapter markers.", file=sys.stderr)

    last = -1
    for name, start in chapters:
        if start < last:
            print(f"  warning: {name!r} starts before the previous chapter — timestamps may not be whole-book starts", file=sys.stderr)
        last = start

    # Title: --title, else the one typed in the extension (book.json), else the 0:00 chapter.
    saved_title = None
    book_json = args.folder / "book.json"
    if book_json.exists():
        try:
            saved_title = (json.loads(book_json.read_text(encoding="utf-8")).get("title") or "").strip() or None
        except (ValueError, OSError):
            pass
    at_zero = next((name for name, start in chapters if start == 0), None)
    title = args.title or saved_title or at_zero or (chapters[0][0] if chapters else args.folder.name)
    safe = title.replace(": ", " - ").replace(":", " -")
    safe = re.sub(r'[\\/*?"<>|]', "_", safe).strip() or "audiobook"
    out = args.output or args.folder / f"{safe}.m4b"

    cover = args.cover
    if not cover:
        cover = next((p for ext in ("jpg", "jpeg", "png", "webp", "gif")
                      for p in [args.folder / f"cover.{ext}"] if p.exists()), None)
    if cover and not cover.exists():
        sys.exit(f"Cover image not found: {cover}")

    total = duration_seconds(mp3)
    meta, count = build_metadata(chapters, total, title, args.author)
    h, rem = divmod(int(total), 3600)
    print(f"Title: {title}\nAudio: {h}h{rem // 60:02d}m  |  Chapters: {count}  |  AAC {args.bitrate}\nOutput: {out}")

    with tempfile.TemporaryDirectory() as tmp:
        meta_path = Path(tmp) / "chapters.ffmetadata"
        meta_path.write_text(meta, encoding="utf-8")

        if cover and cover.suffix.lower() == ".svg":
            print(f"Skipping cover {cover.name}: SVG can't be embedded (need a jpg/png).", file=sys.stderr)
            cover = None
        if cover:
            if cover.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                converted = Path(tmp) / "cover.jpg"
                subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(cover), "-frames:v", "1",
                                "-q:v", "2", str(converted)], check=True)
                cover = converted
            dims = subprocess.run(
                [FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                 "-of", "csv=s=x:p=0", str(cover)], capture_output=True, text=True).stdout.strip()
            print(f"Cover: {dims or 'unknown size'}" +
                  ("  (small — Apple Books prefers 1400px+)" if dims and int(dims.split("x")[0]) < 500 else ""))

        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-stats",
               "-i", str(mp3), "-i", str(meta_path)]
        if cover:
            cmd += ["-i", str(cover)]
        cmd += ["-map", "0:a", "-map_metadata", "1", "-map_chapters", "1"]
        if cover:
            cmd += ["-map", "2:v", "-c:v", "copy", "-disposition:v", "attached_pic"]
        cmd += ["-c:a", "aac", "-b:a", args.bitrate, "-movflags", "+faststart", "-f", "ipod", str(out)]
        subprocess.run(cmd, check=True)

    shown = subprocess.run(
        [FFPROBE, "-v", "error", "-show_chapters", "-of", "csv=p=0", str(out)],
        capture_output=True, text=True,
    ).stdout.strip().splitlines()
    print(f"\nDone: {out}\nChapters in file: {len(shown)}")


if __name__ == "__main__":
    main()
