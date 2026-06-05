{
  description = "picopi — an opinionated pi setup";

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
            exec env \
              PICOPI_SRC=${self} \
              PICOPI_PI_BIN=${pkgs.lib.getExe piPkg} \
              PICOPI_UPDATE_HINT="Nix install: update with 'nix profile upgrade picopi' (or 'nix run --refresh')." \
              ${pkgs.bash}/bin/bash ${self}/scripts/picopi-launch.sh "$@"
          '';
        }
      );
    };
}
