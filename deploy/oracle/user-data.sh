#!/bin/bash
# CryptoAlgo backend - Oracle Cloud first-boot script.
# Paste this whole file into: Create instance -> Advanced options -> Management -> Cloud-init script.
# EDIT ONLY THE TWO LINES BELOW. Allowed characters: letters, digits and . _ @ % + = : , -   (no spaces, quotes, # or $).
ADMIN_PASSWORD='CHANGE_ME_at_least_12_chars'
PROXY_SHARED_SECRET='CHANGE_ME_random_at_least_32_chars'
# ---------------------------------------------------------------------------------------------------------------
export ADMIN_PASSWORD PROXY_SHARED_SECRET
exec > >(tee -a /var/log/cryptoalgo-setup.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates openssl
if [ -d /opt/cryptoalgo/.git ]; then
  git -C /opt/cryptoalgo pull --ff-only
else
  git clone --depth 1 --branch main https://github.com/vikrantsingh07-ai/Crypto-Algo.git /opt/cryptoalgo
fi
bash /opt/cryptoalgo/deploy/oracle/setup.sh
