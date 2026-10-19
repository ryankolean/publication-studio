import type { RailProps } from "./Frame.js";
import type { StepId, Walkthrough } from "./model.js";

/** What every wizard screen after the wedding's creation is handed. */
export interface StepContext {
  eventId: string;
  step: StepId;
  /** GET /events/:id/walkthrough, read when this screen opened. */
  walkthrough: Walkthrough;
  /** The package in the address, else the one the server follows. */
  packageId: string | null;
  rail: RailProps;
  /** Where Back goes: the previous screen, or the wedding chooser. */
  back: string;
  /** Moves to another screen, carrying the package along. */
  go: (step: StepId, packageId?: string | null) => void;
  /** Reads the walkthrough again, for screens that stay put after a save. */
  reload: () => void;
}
