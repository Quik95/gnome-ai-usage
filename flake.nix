{
  description = "GNOME Shell frontend for the tideSI (formerly kde-ai-usage) provider backend";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default-linux";

    devenv = {
      url = "github:cachix/devenv";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Provider backend, icons and shared history/format JS are taken from upstream
    # at build time instead of being vendored or forked.
    tidesi = {
      url = "github:Muddyblack/tidesi/v4.0.1";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  nixConfig = {
    extra-trusted-public-keys = "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
    extra-substituters = "https://devenv.cachix.org";
  };

  outputs = {
    self,
    nixpkgs,
    devenv,
    systems,
    ...
  } @ inputs: let
    forEachSystem = nixpkgs.lib.genAttrs (import systems);
  in {
    formatter = forEachSystem (system: nixpkgs.legacyPackages.${system}.alejandra);

    packages = forEachSystem (system: {
      default = nixpkgs.legacyPackages.${system}.callPackage ./package.nix {
        inherit (inputs) tidesi;
      };
    });

    checks = forEachSystem (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};
        package = self.packages.${system}.default;
        extensionDir = "${package}/share/gnome-shell/extensions/${package.extensionUuid}";
      in {
        inherit package;

        formatting = pkgs.runCommand "alejandra-check" {nativeBuildInputs = [pkgs.alejandra];} ''
          alejandra --check ${self}
          touch $out
        '';

        # The converted upstream modules, the history-io round trip and the
        # mapping helpers, against provider results normalized from upstream's
        # recorded fixtures (no network, no credentials).
        gjs = pkgs.runCommand "gjs-tests" {nativeBuildInputs = [pkgs.gjs];} ''
          export HOME=$TMPDIR XDG_CACHE_HOME=$TMPDIR/cache
          mkdir fixtures
          for f in claude-success openai-codex-success claude-offline; do
            ${extensionDir}/tools/sh/get-ai-usage --normalize \
              <${inputs.tidesi}/tests/fixtures/$f.json >fixtures/$f.json
          done
          EXT_DIR=${extensionDir} FIXTURES_DIR=$PWD/fixtures gjs -m ${./tests/extension.test.js}
          touch $out
        '';
      }
    );

    devShells = forEachSystem (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        default = devenv.lib.mkShell {
          inherit inputs pkgs;
          modules = [
            {
              # https://devenv.sh/reference/options/
              packages = with pkgs; [
                alejandra
                dbus # dbus-run-session for headless gnome-shell test sessions
                gettext
                gjs
                glib # glib-compile-schemas, gsettings, gdbus
                gnome-shell # headless test sessions, gnome-extensions
                jq
                python3 # runs the upstream backend
              ];

              env.AI_USAGE_UPSTREAM = "${inputs.tidesi}";

              enterShell = ''
                echo "upstream backend: $AI_USAGE_UPSTREAM/backend/sh/get-ai-usage"
              '';
            }
          ];
        };
      }
    );
  };
}
