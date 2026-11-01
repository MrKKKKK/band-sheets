// Side-effect module: imported first by every analysis Worker entry, so it runs before any analyzer module.
import { lockDownNetwork } from './networkLockdown';

lockDownNetwork(self);
