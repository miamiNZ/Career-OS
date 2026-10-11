import "reflect-metadata";
import { container } from "./inversify.config.js";
import { TYPES } from "./ioc/types.js";
import type { PipelineService } from "./ioc/services/PipelineService.js";

const pipeline = container.get<PipelineService>(TYPES.PipelineService);

pipeline.run().catch((e) => {
  console.error(e);
  process.exit(1);
});
