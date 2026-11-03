import { createContext, useContext } from 'react';

/**
 * App-wide live state: router status snapshot, connection flags, and counters
 * ("ticks") that bump whenever the server pushes new data of a kind. Pages put a
 * tick in their effect deps to refresh exactly when relevant data changes.
 */
export const LiveContext = createContext(null);
export const useLive = () => useContext(LiveContext);
