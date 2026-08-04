import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import React, { type FC } from 'react';

import { useBrandingOptions } from 'apps/dashboard/features/branding/api/useBrandingOptions';
import globalize from 'lib/globalize';

import MarkdownBox from './MarkdownBox';

interface AboutDialogProps {
    onClose: () => void
}

/** Displays the server-defined About content as sanitized Markdown. */
const AboutDialog: FC<AboutDialogProps> = ({ onClose }) => {
    const { data: brandingOptions, isPending, isError } = useBrandingOptions();

    const renderContent = () => {
        if (isPending) {
            return (
                <Box
                    sx={{
                        display: 'flex',
                        justifyContent: 'center',
                        py: 4
                    }}
                >
                    <CircularProgress />
                </Box>
            );
        }

        if (isError) {
            return (
                <Alert severity='error'>
                    {globalize.translate('AboutLoadError')}
                </Alert>
            );
        }

        return (
            <MarkdownBox
                markdown={brandingOptions?.About}
                fallback={globalize.translate('AboutNotConfigured')}
            />
        );
    };

    return (
        <Dialog
            fullWidth
            maxWidth='md'
            open
            onClose={onClose}
        >
            <DialogTitle>{globalize.translate('About')}</DialogTitle>
            <DialogContent dividers>
                {renderContent()}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>
                    {globalize.translate('ButtonClose')}
                </Button>
            </DialogActions>
        </Dialog>
    );
};

export default AboutDialog;
