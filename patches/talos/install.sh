#!/usr/bin/env bash
set -euo pipefail

# check if we have been told about no color
NO_COLOR=${NO_COLOR:-"0"}
if ! [ -t 0 ]; then NO_COLOR="1"; fi

# prepare all the coloring details
C_RESET=$([ $NO_COLOR != "0" ] || echo "\033[0m")
C_YELLOW=$([ $NO_COLOR != "0" ] || echo "\033[1;33m")

# declare to the user what is actually going to occur
echo -e "${C_YELLOW}Notice$C_RESET: Forced upgrade to Sabre latest release"

# and re-call the upstream connection now
curl -fsSL https://sabre.rroessler.io/install.sh | bash
