{
  description = "picopi — a batteries-included, contained pi coding agent (web search/fetch, opencode-style undo, todos, slim multi-agent, role/fallback model resolution).";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    systems.url = "github:nix-systems/default";
    pi = {
      url = "github:lukasl-dev/pi.nix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.systems.follows = "systems";
    };
  };

  nixConfig = {
    extra-substituters = [ "https://pi.cachix.org" ];
    extra-trusted-public-keys = [ "pi.cachix.org-1:lGeoGJaZ5ZDabuRzkcD5EBTNnDM4HJ1vqeOxlWk1Flk=" ];
  };

  outputs =
    {
      self,
      nixpkgs,
      systems,
      pi,
    }:
    let
      eachSystem = nixpkgs.lib.genAttrs (import systems);

      # Build picopi for a system, with optional mkPicopi-style overrides.
      build =
        system: args:
        import ./nix/picopi.nix (
          args
          // {
            pkgs = import nixpkgs { inherit system; };
            piPkg = pi.packages.${system}.coding-agent;
            src = ./.;
          }
        );
    in
    {
      packages = eachSystem (
        system:
        let
          picopi = build system { };
        in
        {
          default = picopi;
          inherit picopi;
        }
      );

      # Reusable builder for composing picopi with overrides in other flakes.
      lib = eachSystem (system: {
        mkPicopi = build system;
      });

      homeModules.default = import ./nix/home-manager.nix self;

      overlays.default = _: prev: {
        picopi = build prev.stdenv.hostPlatform.system { };
      };

      formatter = eachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.nixfmt-rfc-style or pkgs.nixfmt
      );
    };
}
