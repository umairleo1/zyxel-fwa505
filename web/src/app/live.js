import { createContext, useContext } from 'react';

/**
 * App-wide live state: router status snapshot, connection flags, and counters
 * ("ticks") that bump whenever the server pushes new data of a kind. Pages put a
 * tick in their effect deps to refresh exactly when relevant data changes.
 */
export const LiveContext = createContext(null);
export const useLive = () => useContext(LiveContext);

/**
 * Just the toast function, which never changes: for components that only notify, so
 * they don't re-render on every status push (about once a second) like useLive does.
 */
export const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);
