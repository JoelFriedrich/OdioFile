# OdioFile

A personal Chrome extension that builds an audiobook bundle from the web audiobook player you are listening in: the audio merged into one MP3 (or split into one MP3 per chapter), the chapter list, and the cover. A small script, `make_m4b.py`, then turns the merged bundle into a single chaptered `.m4b` file for audiobook apps.

Not published anywhere. You install it by loading this folder into Chrome yourself.

## What it makes

Everything is saved to `Downloads/OdioFile/<book title>/`:

| File | What it is |
| --- | --- |
| `audiobook.mp3` | All the audio parts joined into one file |
| `table-of-contents.csv` | Chapter titles and start times |
| `cover.jpg` | The cover image |
| `book.json` | The book title you confirmed |
| `Chapters/` | Only if you tick "Split into one MP3 per chapter": one tagged MP3 per chapter, **instead of** `audiobook.mp3` |

Nothing is saved until the whole build succeeds.

## One-time setup

### 1. Install the extension

1. Get this folder onto your Mac (see "Updating" for how) and keep it somewhere permanent, such as Documents. Chrome loads the extension from that location.
2. In Chrome go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `OdioFile` folder.
3. Optionally pin it from the puzzle-piece menu. `Alt+Shift+M` opens it too.

If you move or rename the folder, remove the extension and load it again.

### 2. Tools for the M4B step (skip if you only want MP3s)

The M4B step needs **Python 3** and **ffmpeg** (with `ffprobe`). Choose the section for your Mac.

#### macOS 12 or newer: use Homebrew

Install Homebrew from <https://brew.sh> if `brew --version` does not work, run the "Next steps" lines it prints, then:

```bash
brew install ffmpeg python
```

On macOS 14 or older this may compile everything from source and take a very long time. If so, use the prebuilt route below.

#### Older Macs (for example macOS 10.15 Catalina): prebuilt downloads

Homebrew no longer supports these systems, so skip it.

1. **Python:** download the *macOS 64-bit universal2 installer* for Python 3.12.10 from <https://www.python.org/downloads/release/python-31210/> and run it. In a new Terminal window, `python3 --version` should print `Python 3.12.10`.
2. **ffmpeg:** open <https://evermeet.cx/ffmpeg/> (these are Intel Mac builds) and download the **ZIP** for `ffmpeg` and the **ZIP** for `ffprobe`. Double-click each zip to get the two files named `ffmpeg` and `ffprobe`.
3. Put those two files **next to** the `OdioFile` folder (in the same folder that contains it), not inside it, so updating never removes them. The script also finds them inside the folder if you prefer.
4. Tell macOS they are safe. In Terminal, type `xattr -dr com.apple.quarantine ` (with a trailing space), drag the `ffmpeg` file into the window, drag the `ffprobe` file in, and press Return.

Chrome 128 is the last version that runs on Catalina. It stops updating, but the extension works with it.

## Using it

### Build a book

1. Open the audiobook in its web player in Chrome and click the OdioFile icon.
2. Check the **book title** (filled in from the page title; fix it if it is wrong). The cover should appear next to it.
3. Optionally tick **Split into one MP3 per chapter**. Without it you get one merged file, which is what the M4B step needs.
4. Click **Build audiobook**. A new tab opens.
5. When it asks, switch to the player tab and leave it alone. OdioFile starts playback (muted), steps through every chapter so the player loads all the audio, then returns to the start and restores play/pause and volume. A blue banner says when it is done. Switch back to the OdioFile tab.
6. When the build finishes, the files are in `Downloads/OdioFile/<book title>/`.

If a part is missing the build stops and saves nothing. If the audio is shorter than the chapter list says, it pauses and asks before saving.

### Convert to M4B

In Terminal, go to this folder, then run the script on the bundle folder:

```bash
cd path/to/OdioFile
python3 make_m4b.py "path/to/Downloads/OdioFile/Book Title" --author "Author Name"
```

(Typing `cd ` and dragging a folder into the Terminal window fills in its path.) The finished `Book Title.m4b`, with chapters and cover, appears in the same folder. Options: `--title`, `--author`, `--bitrate` (default `64k`), `--cover`, `-o`.

A bundle built with "Split into one MP3 per chapter" has no merged file, so it cannot be converted. Build it again without splitting.

## Updating

This is a private repository. Whoever it is shared with can update like this:

- **Download a zip:** on the repository page choose **Code > Download ZIP**, unzip it, select everything inside the new folder, copy it into your existing `OdioFile` folder, and choose **Replace**. Keep the folder in the same place.
- **Or with git:** `git pull` inside the folder.

Then open `chrome://extensions` and click the circular **reload** arrow on the OdioFile card. The version number in the card tells you which one you have.

## Troubleshooting

- **`python3: command not found`:** redo the Python step and open a fresh Terminal window.
- **`ffmpeg not found`:** the `ffmpeg` and `ffprobe` files are not on the path, next to this folder, or inside it.
- **macOS says ffmpeg cannot be opened or verified:** redo the `xattr` step above.
- **`Illegal instruction: 4`:** the zip did not unpack properly. Delete both files, download the ZIP versions again and double-click to unzip.
- **The build says parts are missing:** keep the player tab in front while the banner is showing, then build again.
- **Where did my files go:** `Downloads/OdioFile/`. Chrome extensions can only save inside the Downloads folder.

## How it works

The player only requests some audio parts while it is playing, and only while its tab is visible, so the extension drives the play button and chapter list itself. It then reads the part files the page requested, joins them without re-encoding (dropping each file's own headers so players show the right length), and builds the bundle in memory. Splitting cuts the same data at MP3 frame boundaries using the chapter times, without re-encoding; chapter times are whole seconds, so a cut can be about a second from the true start.

The extension reads the player page's own element names, so it only works with the player it was written for.
