-- Pictures inside Google Docs.
--
-- A resource is either linked to a Google file, which stays the one place it is edited, or held in
-- Wisdom. Either way Wisdom keeps a copy of the body to search and show, and for a Google Doc that body
-- has pictures in it: a header, a diagram. Google's export points at them with temporary addresses, so
-- the stored body lost its pictures once those lapsed. inline_images records the copies made in the
-- Wisdom Drive, by image hash, so the body can point at something that lasts and an unchanged picture is
-- not uploaded again each time the document is re-read.
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "inline_images" jsonb DEFAULT '[]'::jsonb NOT NULL;
