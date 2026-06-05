import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

const mockNavigate = jest.fn();
const mockSetOptions = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn(), setOptions: mockSetOptions }),
  useFocusEffect: (cb: () => void) => {
    const ReactLib = require('react');
    ReactLib.useEffect(() => {
      cb();
    }, []);
  },
}));

const mockFindAll = jest.fn();
jest.mock('../../../src/db/repositories/PersonnelRepository', () => ({
  usePersonnelRepository: () => ({ findAll: mockFindAll }),
}));

import PersonnelListScreen from '../../../src/screens/PersonnelListScreen';

const renderScreen = () =>
  render(
    <PaperProvider>
      <PersonnelListScreen />
    </PaperProvider>,
  );

describe('PersonnelListScreen', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockSetOptions.mockClear();
    mockFindAll.mockReset();
  });

  it('given_header_verify_button_when_pressed_then_navigates_to_verification', async () => {
    mockFindAll.mockResolvedValue([]);
    renderScreen();
    await screen.findByText('No personnel registered yet.');

    // The Verify action is installed on the navigation header via setOptions.
    const headerRight = mockSetOptions.mock.calls.at(-1)?.[0]?.headerRight;
    expect(headerRight).toBeDefined();
    render(<PaperProvider>{headerRight()}</PaperProvider>);
    fireEvent.press(screen.getByLabelText('Verify personnel'));
    expect(mockNavigate).toHaveBeenCalledWith('Verification');
  });

  it('given_no_personnel_when_rendered_then_shows_empty_state', async () => {
    mockFindAll.mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText('No personnel registered yet.')).toBeTruthy();
  });

  it('given_personnel_when_rendered_then_shows_name_id_and_role', async () => {
    mockFindAll.mockResolvedValue([
      {
        id: '1',
        fullName: 'Asha Rao',
        employeeId: 'E1',
        role: 'Inspector',
        registeredAt: '',
        updatedAt: '',
        syncStatus: 'pending',
      },
    ]);
    renderScreen();
    expect(await screen.findByText('Asha Rao')).toBeTruthy();
    expect(screen.getByText('E1 · Inspector')).toBeTruthy();
  });

  it('given_row_when_pressed_then_navigates_to_detail_with_id', async () => {
    mockFindAll.mockResolvedValue([
      {
        id: '42',
        fullName: 'Bo Li',
        employeeId: 'E2',
        role: 'Guard',
        registeredAt: '',
        updatedAt: '',
        syncStatus: 'pending',
      },
    ]);
    renderScreen();
    fireEvent.press(await screen.findByText('Bo Li'));
    expect(mockNavigate).toHaveBeenCalledWith('PersonnelDetail', { personnelId: '42' });
  });

  it('given_fab_when_pressed_then_navigates_to_create_mode', async () => {
    mockFindAll.mockResolvedValue([]);
    renderScreen();
    await screen.findByText('No personnel registered yet.');
    // In the empty state the FAB is the only button on screen.
    fireEvent.press(screen.getByRole('button'));
    expect(mockNavigate).toHaveBeenCalledWith('PersonnelDetail', {});
  });
});
