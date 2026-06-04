import { Suspense } from 'react';
import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { runMigrations } from './src/db/migrations';
import AppNavigator from './src/navigation/AppNavigator';
import { theme } from './src/components/theme';

function LoadingScreen() {
  return (
    <View style={styles.loadingContainer}>
      <ActivityIndicator size="large" />
      <Text style={styles.loadingText}>Starting app...</Text>
    </View>
  );
}

export default function App() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <SQLiteProvider databaseName="nhai.db" onInit={runMigrations} useSuspense>
        <PaperProvider theme={theme}>
          <StatusBar style="auto" />
          <AppNavigator />
        </PaperProvider>
      </SQLiteProvider>
    </Suspense>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f7f4ee',
  },
  loadingText: {
    marginTop: 12,
    color: '#3f3a33',
    fontSize: 16,
    fontWeight: '500',
  },
});