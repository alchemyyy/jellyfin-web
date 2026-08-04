import React, { FC, useCallback, useEffect, useState } from 'react';

import { EventType } from 'constants/eventType';
import Events from 'utils/events';

import AboutDialog from './AboutDialog';

interface AppHeaderParams {
    isHidden?: boolean
}

const AppHeader: FC<AppHeaderParams> = ({
    isHidden = false
}) => {
    const [ isAboutDialogOpen, setIsAboutDialogOpen ] = useState(false);

    const closeAboutDialog = useCallback(() => {
        setIsAboutDialogOpen(false);
    }, []);

    useEffect(() => {
        // Initialize the UI components after first render
        void import('../scripts/libraryMenu');

        const showAboutDialog = () => {
            setIsAboutDialogOpen(true);
        };

        Events.on(document, EventType.SHOW_ABOUT, showAboutDialog);

        return () => {
            Events.off(document, EventType.SHOW_ABOUT, showAboutDialog);
        };
    }, []);

    return (
        <>
            {/**
             * NOTE: These components are not used with the new layouts, but legacy views interact with the elements
             * directly so they need to be present in the DOM. We use display: none to hide them and prevent errors.
             */}
            <div style={isHidden ? { display: 'none' } : undefined}>
                <div className='mainDrawer hide'>
                    <div className='mainDrawer-scrollContainer scrollContainer focuscontainer-y' />
                </div>
                <div className='skinHeader focuscontainer-x' />
                <div className='mainDrawerHandle' />
            </div>

            {isAboutDialogOpen && (
                <AboutDialog onClose={closeAboutDialog} />
            )}
        </>
    );
};

export default AppHeader;
