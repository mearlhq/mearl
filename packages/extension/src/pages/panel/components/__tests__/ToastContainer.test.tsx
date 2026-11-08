import { useLayoutEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToastContainer } from '../ToastContainer';
import { showToast } from '../../utils/toast';

function ShowToastOnMount() {
  useLayoutEffect(() => {
    showToast('Saved', 'success');
  }, []);

  return null;
}

describe('ToastContainer', () => {
  it('receives toast events during the mounting commit', () => {
    render(
      <>
        <ToastContainer />
        <ShowToastOnMount />
      </>,
    );

    expect(screen.getByText('Saved')).toBeInTheDocument();
  });
});
