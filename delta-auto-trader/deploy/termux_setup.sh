#!/data/data/com.termux/files/usr/bin/bash
# Android (Termux) setup. Run once:  bash deploy/termux_setup.sh
set -e
pkg update -y && pkg install -y python git termux-services
cd "$(dirname "$0")/.."
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
[ -f .env ] || cp .env.example .env
echo "Edit .env (nano .env): set DELTA_DEMO_API_KEY / DELTA_DEMO_API_SECRET, then: python main.py check"
