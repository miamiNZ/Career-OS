import { injectable } from "inversify";
import { config, vault, hardFilters } from "../../config.js";

/**
 * Injectable facade over the process configuration. The concrete `config`/`vault`
 * objects are also bound as constant values (TYPES.Config / TYPES.Vault) for services
 * that only need the data; this service exposes them behind a stable interface and
 * keeps a single place to read env-derived settings.
 */
@injectable()
export class ConfigService {
  readonly config = config;
  readonly vault = vault;
  readonly hardFilters = hardFilters;

  get anthropicApiKey(): string {
    return config.anthropicApiKey;
  }

  get vaultPath(): string {
    return config.vaultPath;
  }
}
