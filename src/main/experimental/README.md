# Experimental Main-Process Utilities

These modules are retained prototypes and are not imported by the production
application:

- `DebugManager.js`
- `QueueOptimizer.js`
- `RateLimiter.js`
- `RestockPredictor.js`

Keeping them here prevents planned or unused behavior from being mistaken for
active checkout logic. A module should move into a production domain folder
only when it has a real caller and focused tests.
