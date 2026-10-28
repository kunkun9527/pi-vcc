# Publishing policy for this fork

This fork is installed from the GitHub `tom` branch. It does not
automatically publish `@monotykamary/pi-vcc` to npm.

The upstream `.github/workflows/publish.yml` was removed because its
package identity and OIDC trust configuration belong to the original
upstream maintainer. A future release needs its own independently
controlled package name, semantic versioning, explicit release workflow
and npm provenance configuration. No automated npm publishing is
configured for this fork.
