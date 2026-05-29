import React from 'react';
import { View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import PersonnelListScreen from '../screens/PersonnelListScreen';
import PersonnelDetailScreen from '../screens/PersonnelDetailScreen';
import VerificationScreen from '../screens/VerificationScreen';

export type RootStackParamList = {
  PersonnelList: undefined;
  PersonnelDetail: { personnelId?: string };
  Verification: undefined;
  BackupStatus: undefined;
};

const Stack = createStackNavigator<RootStackParamList>();

function PlaceholderScreen() {
  return <View style={{ flex: 1 }} />;
}

export default function AppNavigator() {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator initialRouteName="PersonnelList">
          <Stack.Screen
            name="PersonnelList"
            component={PersonnelListScreen}
            options={{ title: 'Personnel' }}
          />
          <Stack.Screen
            name="PersonnelDetail"
            component={PersonnelDetailScreen}
            options={({ route }) =>
              ({ title: route.params?.personnelId ? 'Edit Personnel' : 'Register Personnel' })
            }
          />
          <Stack.Screen
            name="Verification"
            component={VerificationScreen}
            options={{ title: 'Verify Personnel' }}
          />
          <Stack.Screen
            name="BackupStatus"
            component={PlaceholderScreen}
            options={{ title: 'Backup Status' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
