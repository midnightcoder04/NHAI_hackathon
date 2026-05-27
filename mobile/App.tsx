import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { Text, View } from 'react-native';
import { runMigrations } from './src/db/migrations';

export default function App() {
  return (
    <SQLiteProvider databaseName="nhai.db" onInit={runMigrations}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text>NHAI Field Ops</Text>
        <StatusBar style="auto" />
      </View>
    </SQLiteProvider>
  );
}
