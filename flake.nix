{
  description = "picopi — a batteries-included pi coding agent setup";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
    pi = {
      url = "github:lukasl-dev/pi.nix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.systems.follows = "systems";
    };
  };

  outputs = { self, nixpkgs, systems, pi }:
    let
      eachSystem = nixpkgs.lib.genAttrs (import systems);
    in
    {
      packages = eachSystem (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          piPkg = pi.packages.${system}.coding-agent;
        in
        {
          default = pkgs.writeShellScriptBin "picopi" ''
            set -euo pipefail

            dir="''${PICOPI_HOME:-''${XDG_CONFIG_HOME:-$HOME/.config}/picopi}"
            mkdir -p "$dir"

            [ -e "$dir/settings.json" ] || cp ${self}/agent/settings.json "$dir/settings.json"
            [ -e "$dir/config.json" ] || cp ${self}/agent/config.json "$dir/config.json"
            [ -e "$dir/models.json" ] || printf '{\n  "providers": {}\n}\n' > "$dir/models.json"

            export PI_CODING_AGENT_DIR="$dir"
            exec ${pkgs.lib.getExe piPkg} \
              --extension ${self}/src \
              --prompt-template ${self}/agent/prompts \
              --theme ${self}/agent/themes \
              --append-system-prompt ${self}/agent/AGENTS.md \
              "$@"
          '';
        }
      );
    };
}
