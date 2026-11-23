import { createTranslate, createUseT, defineTable } from '../../../shared/i18n/index';
import { archiveRows } from './archiveRows';
import { checkRows } from './checkRows';
import { consoleRows } from './consoleRows';
import { detailsRows } from './detailsRows';
import { reasonRows } from './reasonRows';
import { reportRows, seriesRows } from './reportRows';
import { reviewRows } from './reviewRows';
import { runRows } from './runRows';
import { sendRows } from './sendRows';

/**
 * The words of one task: its panel, form, review, versions, the reasons it cannot start, and its
 * AI work (Send to AI, the launch dialog, the run, the research and checks, the series, the console
 * of a Console mode run).
 */
export const taskCatalogs = defineTable({
  ...detailsRows,
  ...archiveRows,
  ...reviewRows,
  ...reasonRows,
  ...sendRows,
  ...runRows,
  ...checkRows,
  ...reportRows,
  ...seriesRows,
  ...consoleRows,
});

export const useTaskT = createUseT(taskCatalogs);

/** For the model functions that compose a sentence outside a component, in the language shown. */
export const taskT = createTranslate(taskCatalogs);
