import React, { useCallback, useLayoutEffect, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Appbar, FAB, List, Text } from 'react-native-paper';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { usePersonnelRepository } from '../db/repositories/PersonnelRepository';
import type { Personnel } from '../models/Personnel';
import type { RootStackParamList } from '../navigation/AppNavigator';

type NavProp = StackNavigationProp<RootStackParamList, 'PersonnelList'>;

export default function PersonnelListScreen() {
  const navigation = useNavigation<NavProp>();
  const repo = usePersonnelRepository();
  const [personnel, setPersonnel] = useState<Personnel[]>([]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <>
          <Appbar.Action
            icon="cloud-upload-outline"
            accessibilityLabel="Backup status"
            onPress={() => navigation.navigate('BackupStatus')}
          />
          <Appbar.Action
            icon="face-recognition"
            accessibilityLabel="Verify personnel"
            onPress={() => navigation.navigate('Verification')}
          />
        </>
      ),
    });
  }, [navigation]);

  useFocusEffect(
    useCallback(() => {
      repo.findAll().then(setPersonnel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const renderItem = useCallback(
    ({ item }: { item: Personnel }) => (
      <List.Item
        title={item.fullName}
        description={`${item.employeeId} · ${item.role}`}
        onPress={() => navigation.navigate('PersonnelDetail', { personnelId: item.id })}
      />
    ),
    [navigation],
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={personnel}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        ListEmptyComponent={
          <Text style={styles.empty}>No personnel registered yet.</Text>
        }
      />
      <FAB
        icon="plus"
        accessibilityLabel="Register personnel"
        style={styles.fab}
        onPress={() => navigation.navigate('PersonnelDetail', {})}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  empty: { textAlign: 'center', marginTop: 40, color: '#888' },
  fab: { position: 'absolute', right: 16, bottom: 24 },
});
