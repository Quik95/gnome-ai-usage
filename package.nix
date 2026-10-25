{
  lib,
  stdenvNoCC,
  python3,
  kde-ai-usage,
}: let
  uuid = "ai-usage@quik95.github.io";

  # Pure JS shared by the upstream frontends: top-level `function`/`var` only,
  # no Qt APIs, so appending an export list is all it takes to make them ESM.
  sharedModules = ["Format" "UsageHistory" "FeatureTabs"];
in
  stdenvNoCC.mkDerivation {
    pname = "gnome-shell-extension-ai-usage";
    version = "0.1.0";

    src = kde-ai-usage;

    postPatch = ''
      # The shell tools resolve Python from PATH, but gnome-shell inherits the
      # systemd user session's PATH, which on NixOS has no Python at all, so
      # every provider would report "python3 missing". Same pin as upstream's
      # own flake; --replace-fail turns a drifted line into a build error.
      substituteInPlace package/contents/tools/sh/python-interp.sh \
        --replace-fail 'PY_DEFAULT="python3"' \
                       'PY_DEFAULT="${python3}/bin/python3"'

      # Upstream honors CLAUDE_CONFIG_DIR everywhere except the stats/settings reads.
      substituteInPlace package/contents/tools/aiusage/collect.py \
        --replace-fail 'os.path.expanduser("~/.claude/' \
          'os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "'
    '';

    dontConfigure = true;
    dontBuild = true;

    installPhase = ''
      runHook preInstall

      contents=package/contents
      dest=$out/share/gnome-shell/extensions/${uuid}
      mkdir -p "$dest/tools/sh" "$dest/icons" "$dest/shared"

      # Python backend (stdlib only) and the launchers the extension runs.
      cp -r "$contents/tools/aiusage" "$dest/tools/"
      install -m755 -t "$dest/tools/sh" \
        "$contents/tools/sh/get-ai-usage" \
        "$contents/tools/sh/history-io"
      install -m644 -t "$dest/tools/sh" "$contents/tools/sh/python-interp.sh"

      # Provider logos as-is for the popup, plus a -symbolic copy of each so
      # St recolors them with the CSS `color` of the panel readout.
      for icon in "$contents"/icons/*.svg; do
        name=$(basename "$icon" .svg)
        install -m644 "$icon" "$dest/icons/$name.svg"
        install -m644 "$icon" "$dest/icons/$name-symbolic.svg"
      done
      install -m644 "$contents/icons/LICENSE.lobehub" "$dest/icons/"

      for module in ${lib.escapeShellArgs sharedModules}; do
        src_js="$contents/code/$module.js"
        names=$(grep -oP '^(function|var) \K\w+' "$src_js" | paste -sd, - | sed 's/,/, /g')
        if [ -z "$names" ]; then
          echo "no top-level names found in $src_js" >&2
          exit 1
        fi
        {
          grep -v '^\.pragma ' "$src_js"
          printf '\nexport { %s };\n' "$names"
        } >"$dest/shared/$module.js"
      done

      install -m644 LICENSE "$dest/LICENSE.kde-ai-usage"

      runHook postInstall
    '';

    passthru.extensionUuid = uuid;

    meta = {
      description = "GNOME Shell frontend for the kde-ai-usage provider backend";
      homepage = "https://github.com/Quik95/gnome-ai-usage";
      platforms = lib.platforms.linux;
    };
  }
