import { createContext } from 'react-router';

// true = authenticated as admin (no per-tenant scoping)
export const adminContext = createContext<boolean>(false);
