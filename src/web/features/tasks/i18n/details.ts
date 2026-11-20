import { createTranslate, createUseT, defineTable } from '../../../shared/i18n/index';
import { detailsRows } from './detailsRows';
import { reasonRows } from './reasonRows';
import { reviewRows } from './reviewRows';

/** The words of one task: its panel, form, review, versions, and the reasons it cannot start. */
export const taskCatalogs = defineTable({ ...detailsRows, ...reviewRows, ...reasonRows });

export const useTaskT = createUseT(taskCatalogs);

/** For the model functions that compose a sentence outside a component, in the language shown. */
export const taskT = createTranslate(taskCatalogs);
