import { createTranslate, createUseT, defineTable } from '../../../shared/i18n/index';
import { checkRows } from './checkRows';
import { detailsRows } from './detailsRows';
import { reasonRows } from './reasonRows';
import { reportRows, seriesRows } from './reportRows';
import { reviewRows } from './reviewRows';
import { runRows } from './runRows';
import { sendRows } from './sendRows';

/**
 * The words of one task: its panel, form, review, versions, the reasons it cannot start, and its
 * AI work (Send to AI, the launch dialog, the run, the research and checks, the series).
 */
export const taskCatalogs = defineTable({
  ...detailsRows,
  ...reviewRows,
  ...reasonRows,
  ...sendRows,
  ...runRows,
  ...checkRows,
  ...reportRows,
  ...seriesRows,
});

export const useTaskT = createUseT(taskCatalogs);

/** For the model functions that compose a sentence outside a component, in the language shown. */
export const taskT = createTranslate(taskCatalogs);
