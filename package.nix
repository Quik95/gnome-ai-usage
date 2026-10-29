{
  lib,
  stdenvNoCC,
  glib,
  python3,
  tidesi,
}: let
  uuid = "ai-usage@quik95.github.io";

  # Pure JS shared by the upstream frontends: top-level `function`/`var` only,
  # no Qt APIs, so appending an export list is all it takes to make them ESM.
  sharedModules = ["Format" "UsageHistory" "FeatureTabs"];

  extensionSrc = lib.fileset.toSource {
    root = ./extension;
    fileset = ./extension;
  };
in
  stdenvNoCC.mkDerivation {
    pname = "gnome-shell-extension-ai-usage";
    version = "0.1.0";

    src = tidesi;

    postPatch = ''
      # The shell tools resolve Python from PATH, but gnome-shell inherits the
      # systemd user session's PATH, which on NixOS has no Python at all, so
      # every provider would report "python3 missing". Same pin as upstream's
      # own flake; --replace-fail turns a drifted line into a build error.
      substituteInPlace backend/sh/python-interp.sh \
        --replace-fail 'PY_DEFAULT="python3"' \
                       'PY_DEFAULT="${python3}/bin/python3"'

      # Upstream honors CLAUDE_CONFIG_DIR everywhere except the stats/settings reads.
      substituteInPlace backend/tidesi/collect.py \
        --replace-fail 'os.path.expanduser("~/.claude/' \
          'os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "'
    '';

    nativeBuildInputs = [glib];

    dontConfigure = true;
    dontBuild = true;

    installPhase = ''
      runHook preInstall

      icons=assets/icons
      dest=$out/share/gnome-shell/extensions/${uuid}
      mkdir -p "$dest/tools/sh" "$dest/icons" "$dest/shared"

      cp -r ${extensionSrc}/. "$dest/"
      chmod -R u+w "$dest"
      glib-compile-schemas --strict "$dest/schemas"

      # Python backend (stdlib only) and the launchers the extension runs.
      cp -r backend/tidesi "$dest/tools/"
      install -m755 -t "$dest/tools/sh" \
        backend/sh/get-ai-usage \
        backend/sh/history-io
      install -m644 -t "$dest/tools/sh" backend/sh/python-interp.sh

      # Provider logos as-is for the popup, plus a -symbolic twin of each so
      # St recolors them with the CSS `color` of the panel readout. Where the
      # logo does not survive recoloring upstream draws a monochrome variant
      # (antigravity-color -> antigravity-symbolic, kiro -> kiro-symbolic);
      # that one becomes the twin instead of a copy of the color logo.
      for icon in "$icons"/*.svg; do
        name=$(basename "$icon" .svg)
        case $name in *-symbolic) continue ;; esac
        symbolic="$icons/''${name%-color}-symbolic.svg"
        [ -e "$symbolic" ] || symbolic=$icon
        install -m644 "$icon" "$dest/icons/$name.svg"
        install -m644 "$symbolic" "$dest/icons/$name-symbolic.svg"
      done
      install -m644 "$icons/LICENSE.lobehub" "$dest/icons/"

      for module in ${lib.escapeShellArgs sharedModules}; do
        src_js="ui/js/$module.js"
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

      install -m644 ${./LICENSE} "$dest/LICENSE"
      install -m644 LICENSE "$dest/LICENSE.tidesi"

      runHook postInstall
    '';

    passthru.extensionUuid = uuid;

    meta = {
      description = "GNOME Shell frontend for the tideSI (formerly kde-ai-usage) provider backend";
      homepage = "https://github.com/Quik95/gnome-ai-usage";
      license = with lib.licenses; [eupl12 mit];
      platforms = lib.platforms.linux;
    };
  }
