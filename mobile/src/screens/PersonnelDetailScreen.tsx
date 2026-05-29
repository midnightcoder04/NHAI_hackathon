import React, { useEffect, useRef, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
  Button,
  Dialog,
  Portal,
  Snackbar,
  Text,
  TextInput,
} from 'react-native-paper';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import {
  Camera,
  type CameraRef,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';
import { usePersonnelRepository } from '../db/repositories/PersonnelRepository';
import { useFaceImageRepository } from '../db/repositories/FaceImageRepository';
import { ImageStorageService, StorageFullError } from '../services/ImageStorageService';
import { EmbeddingModel } from '../ml/EmbeddingModel';
import type { RootStackParamList } from '../navigation/AppNavigator';

type RouteType = RouteProp<RootStackParamList, 'PersonnelDetail'>;

// Stub: replaced by SyncOutboxRepository.enqueue in T042
async function enqueueSyncStub(): Promise<void> {}

export default function PersonnelDetailScreen() {
  const navigation = useNavigation();
  const route = useRoute<RouteType>();
  const { personnelId } = route.params ?? {};
  const isEditMode = Boolean(personnelId);

  const personnelRepo = usePersonnelRepository();
  const faceRepo = useFaceImageRepository();

  const [fullName, setFullName] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [role, setRole] = useState('');
  const [capturedImagePath, setCapturedImagePath] = useState<string | null>(null);
  const [capturedEmbedding, setCapturedEmbedding] = useState<Float32Array | null>(null);
  const [snackMsg, setSnackMsg] = useState('');
  const [deleteDialogVisible, setDeleteDialogVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  // The live camera is only mounted while this modal is open — never inline behind
  // the form — so its native preview surface can't overlap or steal taps from the
  // text inputs (Android SurfaceView z-orders above the RN view tree).
  const [cameraVisible, setCameraVisible] = useState(false);

  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('front');
  const cameraRef = useRef<CameraRef>(null);
  const photoOutput = usePhotoOutput();

  useEffect(() => {
    if (!isEditMode || !personnelId) return;
    personnelRepo.findById(personnelId).then(p => {
      if (!p) return;
      setFullName(p.fullName);
      setEmployeeId(p.employeeId);
      setRole(p.role);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personnelId]);

  function openCamera() {
    if (!hasPermission) requestPermission();
    setCameraVisible(true);
  }

  async function capturePhoto() {
    try {
      const photo = await photoOutput.capturePhotoToFile({}, {});
      const now = Date.now();
      const fileName = `${personnelId ?? 'new'}_${now}.jpg`;
      const savedPath = await ImageStorageService.save(photo.filePath, fileName);
      const embedding = await EmbeddingModel.extractEmbedding(savedPath);
      setCapturedImagePath(savedPath);
      setCapturedEmbedding(embedding);
      setCameraVisible(false);
    } catch (err) {
      setCameraVisible(false);
      if (err instanceof StorageFullError) {
        setSnackMsg('Not enough storage to save photo.');
      } else {
        setSnackMsg('Failed to capture photo.');
      }
    }
  }

  async function handleSave() {
    if (!fullName.trim() || !employeeId.trim() || !role.trim()) {
      setSnackMsg('All fields are required.');
      return;
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();

      if (isEditMode && personnelId) {
        await personnelRepo.update(personnelId, { fullName, employeeId, role });
      } else {
        const created = await personnelRepo.create({
          employeeId,
          fullName,
          role,
          registeredAt: now,
          updatedAt: now,
          syncStatus: 'pending',
        });

        if (capturedImagePath && capturedEmbedding) {
          await faceRepo.create({
            personnelId: created.id,
            imagePath: capturedImagePath,
            embedding: capturedEmbedding,
            createdAt: now,
            syncStatus: 'pending',
          });
        }
        await enqueueSyncStub();
      }

      navigation.goBack();
    } catch {
      setSnackMsg('Save failed. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleteDialogVisible(false);
    if (!personnelId) return;
    try {
      ImageStorageService.deleteByPersonnelId(personnelId);
      await personnelRepo.delete(personnelId);
      navigation.goBack();
    } catch {
      setSnackMsg('Delete failed. Please try again.');
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <TextInput
          label="Full Name"
          value={fullName}
          onChangeText={setFullName}
          style={styles.input}
          mode="outlined"
        />
        <TextInput
          label="Employee ID"
          value={employeeId}
          onChangeText={setEmployeeId}
          style={styles.input}
          mode="outlined"
        />
        <TextInput
          label="Role"
          value={role}
          onChangeText={setRole}
          style={styles.input}
          mode="outlined"
        />

        {capturedImagePath ? (
          <Image
            source={{ uri: `file://${capturedImagePath}` }}
            style={styles.thumbnail}
            resizeMode="cover"
          />
        ) : null}

        <Button mode="outlined" icon="camera" onPress={openCamera} style={styles.photoBtn}>
          {capturedImagePath ? 'Retake Photo' : 'Capture Photo'}
        </Button>

        <Button
          mode="contained"
          onPress={handleSave}
          loading={saving}
          disabled={saving}
          style={styles.saveBtn}
        >
          {isEditMode ? 'Save Changes' : 'Register Personnel'}
        </Button>

        {isEditMode ? (
          <Button
            mode="outlined"
            textColor="red"
            onPress={() => setDeleteDialogVisible(true)}
            style={styles.deleteBtn}
          >
            Delete
          </Button>
        ) : null}
      </ScrollView>

      <Modal
        visible={cameraVisible}
        animationType="slide"
        onRequestClose={() => setCameraVisible(false)}
      >
        {hasPermission && device ? (
          <View style={styles.cameraModal}>
            <Camera
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              device={device}
              isActive={cameraVisible}
              outputs={[photoOutput]}
            />
            <View style={styles.cameraControls}>
              <Button mode="contained-tonal" onPress={() => setCameraVisible(false)}>
                Cancel
              </Button>
              <Button mode="contained" onPress={capturePhoto}>
                Capture
              </Button>
            </View>
          </View>
        ) : (
          <View style={styles.cameraPlaceholder}>
            <Text>Camera permission required for photo capture.</Text>
            <Button onPress={requestPermission}>Grant Permission</Button>
            <Button onPress={() => setCameraVisible(false)}>Close</Button>
          </View>
        )}
      </Modal>

      <Portal>
        <Dialog visible={deleteDialogVisible} onDismiss={() => setDeleteDialogVisible(false)}>
          <Dialog.Title>Delete Personnel</Dialog.Title>
          <Dialog.Content>
            <Text>This will permanently delete this record and all associated photos.</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteDialogVisible(false)}>Cancel</Button>
            <Button textColor="red" onPress={handleDelete}>Delete</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar
        visible={Boolean(snackMsg)}
        onDismiss={() => setSnackMsg('')}
        duration={3000}
      >
        {snackMsg}
      </Snackbar>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 16, paddingBottom: 40 },
  input: { marginBottom: 12 },
  photoBtn: { marginBottom: 12 },
  cameraModal: { flex: 1, backgroundColor: 'black' },
  cameraControls: {
    position: 'absolute',
    bottom: 32,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 24,
  },
  cameraPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#f0f0f0',
  },
  thumbnail: { width: '100%', height: 160, borderRadius: 8, marginBottom: 12 },
  saveBtn: { marginBottom: 8 },
  deleteBtn: { borderColor: 'red' },
});
