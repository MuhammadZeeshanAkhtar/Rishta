#!/usr/bin/env bash
#
# Builds the NikahMate demo video from REAL screenshots of the running app.
#
#   bash demo/build-demo.sh
#
# WHAT IS IN IT. Every frame under demo/frames/ is a screenshot of the actual
# Expo app served from localhost, captured at a 9:16 phone viewport. Nothing is
# a mockup and nothing is a design comp.
#
# WHAT IS NOT IN IT, and why. Discover, Family review and Chat are built and
# tested but could not be filmed: the app gates on a verified email address,
# the development Supabase project has confirmation emails enabled, and there
# is no inbox to confirm from. Padding the video with screens that were never
# rendered would be the one thing a demo must not do.
#
# THE MUSIC IS SYNTHESISED, not licensed. Three sine waves held as a slow pad,
# filtered and faded. That is an honest answer to "background music" when no
# licensed track is available, and it ships no rights problem with the file.
#
# Output: demo/output/nikahmate-demo.mp4 — 1080x1920, H.264 High, yuv420p,
# AAC audio. yuv420p specifically because some players show a green or black
# frame for 4:4:4, and a demo that fails to play is worse than no demo.

set -euo pipefail

FFDIR="/c/Users/user/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build-shared/bin"
FFMPEG="$FFDIR/ffmpeg"
FFPROBE="$FFDIR/ffprobe"

HERE="$(cd "$(dirname "$0")" && pwd)"
FRAMES="$HERE/frames"
WORK="$HERE/.work"
OUT="$HERE/output/nikahmate-demo.mp4"

FONT_REG="reg.ttf"
FONT_BOLD="bold.ttf"

# Brand, from docs/BRAND.md.
GREEN="0x0B5D3B"
GOLD="0xC9A227"
CREAM="0xF7F7F2"

SEG=5.5        # seconds each screen holds
FADE=0.7       # crossfade length
W=1080
H=1920

rm -rf "$WORK"
mkdir -p "$WORK" "$HERE/output"

# Fonts are COPIED and referenced by bare filename, then ffmpeg is run from
# the working directory. A Windows font path inside a filter string needs the
# drive-letter colon escaped twice over — once for the shell, once for the
# filter parser — and getting it wrong fails with "No option name near", which
# points at the text rather than at the path. Sidestepped instead of fought.
cp /c/Windows/Fonts/segoeui.ttf  "$WORK/reg.ttf"
cp /c/Windows/Fonts/segoeuib.ttf "$WORK/bold.ttf"
cd "$WORK"

# -----------------------------------------------------------------------------
# 1. Title card and outro, drawn rather than screenshotted.
#
# These are the only frames that are not the app, and they say so by looking
# like a title card rather than like a screen.
# -----------------------------------------------------------------------------

"$FFMPEG" -v error -y -f lavfi -i "color=c=$GREEN:s=${W}x${H}:d=$SEG" \
  -vf "drawtext=fontfile=$FONT_BOLD:text='NikahMate':fontcolor=white:fontsize=96:x=(w-text_w)/2:y=(h-text_h)/2-90,
       drawtext=fontfile=$FONT_REG:text='Find a spouse, with dignity':fontcolor=$GOLD:fontsize=44:x=(w-text_w)/2:y=(h-text_h)/2+40,
       drawtext=fontfile=$FONT_REG:text='A serious platform for Muslims seeking marriage':fontcolor=0xBFD8CB:fontsize=32:x=(w-text_w)/2:y=(h-text_h)/2+120,
       fade=t=in:st=0:d=0.8" \
  -r 30 -pix_fmt yuv420p -c:v libx264 -crf 18 "$WORK/00-title.mp4"

"$FFMPEG" -v error -y -f lavfi -i "color=c=$GREEN:s=${W}x${H}:d=6" \
  -vf "drawtext=fontfile=$FONT_BOLD:text='NikahMate':fontcolor=white:fontsize=104:x=(w-text_w)/2:y=(h-text_h)/2-120,
       drawtext=fontfile=$FONT_REG:text='Private. Respectful. Built around family.':fontcolor=$GOLD:fontsize=40:x=(w-text_w)/2:y=(h-text_h)/2+10,
       drawtext=fontfile=$FONT_REG:text='Phases 1-7 built - 1,133 tests passing':fontcolor=0xBFD8CB:fontsize=30:x=(w-text_w)/2:y=(h-text_h)/2+100,
       drawtext=fontfile=$FONT_REG:text='github.com/MuhammadZeeshanAkhtar/Rishta':fontcolor=0x8FB3A3:fontsize=26:x=(w-text_w)/2:y=h-160,
       fade=t=out:st=4.6:d=1.4" \
  -r 30 -pix_fmt yuv420p -c:v libx264 -crf 18 "$WORK/99-outro.mp4"

# -----------------------------------------------------------------------------
# 2. One clip per screenshot.
#
# A slow push-in (zoompan) keeps a still frame from reading as a dead image,
# and the caption bar sits at the BOTTOM because that is the part of a 9:16
# frame a phone UI leaves empty.
#
# The zoom is small (9%) and runs at the OUTPUT resolution on purpose. The
# textbook trick is to upscale 2x first so zoompan samples a larger source;
# here that meant rendering 2160x3840 and took roughly ten minutes PER CLIP
# for a difference invisible at a 9% push on flat UI screens. Not a trade
# worth making.
# -----------------------------------------------------------------------------

clip() {
  local src="$1" idx="$2" caption="$3" sub="$4"
  local frames=$(python -c "print(int($SEG * 30))")

  # ONE input frame, not a looped stream. zoompan expands each frame it
  # receives into `d` output frames, so `-loop 1 -t 5.5` handed it 165 frames
  # and it produced 165 x 165 = 27,225 — a five-second clip that took ten
  # minutes to render and came out 10MB. The image is read once and zoompan
  # generates the whole clip from it.
  "$FFMPEG" -v error -y -i "$src" \
    -filter_complex "
      [0:v]scale=$W:$H:flags=lanczos,setsar=1[base];
      [base]zoompan=z='min(1.0+0.0009*on,1.09)':d=$frames:s=${W}x${H}:fps=30[zoomed];
      [zoomed]drawbox=y=ih-300:w=iw:h=300:color=black@0.72:t=fill[boxed];
      [boxed]drawtext=fontfile=$FONT_BOLD:text='$caption':fontcolor=white:fontsize=50:x=60:y=h-230,
             drawtext=fontfile=$FONT_REG:text='$sub':fontcolor=0xD8E6DE:fontsize=32:x=60:y=h-150[out]
    " -map "[out]" -r 30 -pix_fmt yuv420p -c:v libx264 -crf 18 "$WORK/$idx.mp4"
}

clip "$FRAMES/01-welcome.jpg"    "01" "Welcome"            "Serious marriage, not casual dating"
clip "$FRAMES/02-signup.jpg"     "02" "Create an account"  "Explicit consent before any religious data is stored"
clip "$FRAMES/03-validation.jpg" "03" "Validation"         "Every field checked before anything is sent"
clip "$FRAMES/04-signin.jpg"     "04" "Sign in"            "Supabase auth, verified email required"
clip "$FRAMES/05-reset.jpg"      "05" "Password reset"     "Deep-link recovery, handled in-app"

# -----------------------------------------------------------------------------
# 3. Crossfade them together.
#
# Chained pairwise rather than one filter_complex over seven inputs: xfade
# offsets are absolute into the accumulated timeline, so a single chain means
# recomputing every offset whenever one segment's length changes.
# -----------------------------------------------------------------------------

join() {
  local a="$1" b="$2" out="$3"
  local alen
  alen=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$a")
  local offset
  offset=$(python -c "print(max(0, $alen - $FADE))")

  "$FFMPEG" -v error -y -i "$a" -i "$b" \
    -filter_complex "[0:v][1:v]xfade=transition=fade:duration=$FADE:offset=$offset,format=yuv420p[v]" \
    -map "[v]" -r 30 -c:v libx264 -crf 18 "$out"
}

cp "$WORK/00-title.mp4" "$WORK/acc.mp4"
for part in 01 02 03 04 05 99-outro; do
  join "$WORK/acc.mp4" "$WORK/$part.mp4" "$WORK/acc-next.mp4"
  mv -f "$WORK/acc-next.mp4" "$WORK/acc.mp4"
done

# -----------------------------------------------------------------------------
# 4. The soundtrack.
#
# Three sine waves a sixth apart, low-passed so nothing is shrill on a phone
# speaker, with a slow tremolo so it breathes rather than drones. Quiet enough
# (-24dB) to sit under narration if any is added later.
# -----------------------------------------------------------------------------

TOTAL=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$WORK/acc.mp4")
FADEOUT=$(python -c "print(max(0, $TOTAL - 2.5))")

"$FFMPEG" -v error -y \
  -f lavfi -i "sine=frequency=220:duration=$TOTAL" \
  -f lavfi -i "sine=frequency=277.18:duration=$TOTAL" \
  -f lavfi -i "sine=frequency=329.63:duration=$TOTAL" \
  -filter_complex "
    [0:a]volume=0.5[a0];
    [1:a]volume=0.32[a1];
    [2:a]volume=0.26[a2];
    [a0][a1][a2]amix=inputs=3:duration=longest:normalize=0[mix];
    [mix]lowpass=f=900,tremolo=f=0.18:d=0.55,volume=-24dB,
         afade=t=in:st=0:d=2,afade=t=out:st=$FADEOUT:d=2.5[a]
  " -map "[a]" -c:a aac -b:a 160k "$WORK/music.m4a"

# -----------------------------------------------------------------------------
# 5. Mux. `-shortest` is deliberate: the pad is generated to the video's exact
#    length, and a mismatch should truncate rather than leave silence hanging.
# -----------------------------------------------------------------------------

# `scale=out_range=tv` and explicit colour tags, not just `-pix_fmt`: the
# frames are JPEGs, so they arrive as yuvj420p (full range) and that
# survives `-pix_fmt yuv420p` as a RELABEL rather than a conversion.
# Players that honour the range flag then render it washed out. Converting
# the range and tagging it leaves nothing for a player to guess.
"$FFMPEG" -v error -y -i "$WORK/acc.mp4" -i "$WORK/music.m4a" \
  -map 0:v -map 1:a \
  -vf "scale=out_range=tv:out_color_matrix=bt709,format=yuv420p" \
  -c:v libx264 -profile:v high -level 4.0 -crf 18 \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
  -movflags +faststart -c:a aac -b:a 160k -shortest "$OUT"

echo
echo "Built: $OUT"
"$FFPROBE" -v error -show_entries format=duration,size,format_name \
  -show_entries stream=codec_name,codec_type,width,height,pix_fmt,profile \
  -of default=noprint_wrappers=1 "$OUT"
