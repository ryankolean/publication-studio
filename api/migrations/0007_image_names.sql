-- The photographer's own file name for each pooled image.
--
-- The send step zips a package's images for the outlet's upload form, and an
-- outlet editor reads file names. Keys are minted server-side as
-- events/<event_id>/<uuid>.<ext>, so the name she gave the file is lost unless
-- it is kept here. Written by PUT /images/:key from the x-file-name header,
-- after the server strips any path and caps the length. NULL for images
-- uploaded before this column existed.

ALTER TABLE event_images ADD COLUMN original_name TEXT;
