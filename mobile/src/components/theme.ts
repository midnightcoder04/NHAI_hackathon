import { MD3LightTheme, type MD3Theme } from 'react-native-paper';

/**
 * T078: single source of truth for the app's React Native Paper theme (Constitution IV —
 * one component library, consistent colours). Only the brand/semantic colours are
 * overridden; everything else inherits the accessible MD3 light defaults (contrast,
 * elevation, typography). `error` drives the destructive/failure UI; `primary` the
 * authorized/positive actions.
 */
export const theme: MD3Theme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: '#1B7A43', // NHAI green — primary actions / Authorized
    onPrimary: '#FFFFFF',
    secondary: '#37607D', // steel blue — secondary actions
    onSecondary: '#FFFFFF',
    error: '#B3261E', // failure / destructive
    onError: '#FFFFFF',
    background: '#F7F4EE', // matches the app's loading background
  },
};
