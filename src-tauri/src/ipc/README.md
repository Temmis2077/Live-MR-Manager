# Rust IPC facade

This module owns the public frontend/backend contract. Commands validate input,
map errors, and delegate to application modules; DSP, database, and network
business logic must not be implemented here.

Domain migration order: audio → library/settings → separation/models/alignment
→ overlay/integrations. `contract_builder` is the single source for generated
bindings during the migration.

