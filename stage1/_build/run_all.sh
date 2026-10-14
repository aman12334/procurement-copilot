#!/bin/zsh
# Rebuilds the whole Stage 1 dataset deterministically.
set -e
cd "$(dirname "$0")"
python3 write_buyer_and_gt.py
python3 vendors.py
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
H="$(cd ..; pwd)/vendors/vendor_4/Sri_Vaigai_Rate_Card_Oct2026.html"
"$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1072,1560 --screenshot="$PWD/v4_chrome_capture.png" "file://$H"
"$CH" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="$(dirname "$H")/Sri_Vaigai_Rate_Card_Oct2026.pdf" "file://$H"
python3 make_images.py v4_chrome_capture.png
python3 validate.py
