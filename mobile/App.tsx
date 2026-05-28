import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { PaperProvider } from 'react-native-paper';
import { runMigrations } from './src/db/migrations';
import AppNavigator from './src/navigation/AppNavigator';

export default function App() {
  return (
    <SQLiteProvider databaseName="nhai.db" onInit={runMigrations}>
      <PaperProvider>
        <StatusBar style="auto" />
        <AppNavigator />
      </PaperProvider>
    </SQLiteProvider>
  );
}
