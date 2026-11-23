"""
Imports every downloaded model into a staging scene, measures it, and renders a front thumbnail.
Output: .tmp/thumbs/<name>.png and .tmp/thumbs/inventory.json (size in metres, triangles, facing unknown).
Run in Blender:  exec(open(r"...\\art\\blender\\inventory_models.py").read())
"""

import json
import math
import os

import bpy
from mathutils import Vector

import os
PROJECT = os.environ.get("ATLAS_PROJECT", r"C:\Users\Strikeout\Projects\atlas")
SRC = os.path.join(PROJECT, "Downloaded-Models")
# Prop categories (characters, animations, textures and HDRIs are not props).
PROP_FOLDERS = ("furniture", "electronics", "kitchen", "decor", "recreation")
THUMBS = os.path.join(PROJECT, ".tmp", "thumbs")
SCENE = "ATLAS_Staging"

os.makedirs(THUMBS, exist_ok=True)

scene = bpy.data.scenes.get(SCENE) or bpy.data.scenes.new(SCENE)
bpy.context.window.scene = scene
for obj in list(scene.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
for col in list(scene.collection.children):
    scene.collection.children.unlink(col)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def import_blend(path):
    with bpy.data.libraries.load(path, link=False) as (src, dst):
        dst.objects = [name for name in src.objects]
    objs = [o for o in dst.objects if o is not None]
    for o in objs:
        scene.collection.objects.link(o)
    return objs


BATCH = globals().get("BATCH")  # optional (start, end) slice of the source list, to keep each call short


def sources():
    """Every prop: glTF files and Poly Haven .blend folders in the category folders."""
    items = []
    for category in PROP_FOLDERS:
        folder = os.path.join(SRC, category)
        for entry in sorted(os.listdir(folder)):
            path = os.path.join(folder, entry)
            if entry.endswith(".glb"):
                items.append((os.path.splitext(entry)[0], path, import_glb))
            elif os.path.isdir(path):
                blend = [f for f in os.listdir(path) if f.endswith(".blend")]
                if blend:
                    items.append((entry, os.path.join(path, blend[0]), import_blend))
    return items[BATCH[0]:BATCH[1]] if BATCH else items



def bounds(objs):
    pts = []
    for o in objs:
        if o.type == "MESH":
            pts += [o.matrix_world @ Vector(c) for c in o.bound_box]
    if not pts:
        return None
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def triangles(objs):
    total = 0
    for o in objs:
        if o.type == "MESH":
            total += sum(len(p.vertices) - 2 for p in o.data.polygons)
    return total


# Camera and lights for thumbnails
cam_data = bpy.data.cameras.new("ThumbCam")
cam = bpy.data.objects.new("ThumbCam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
sun = bpy.data.objects.new("ThumbSun", bpy.data.lights.new("ThumbSun", "SUN"))
sun.data.energy = 3.0
sun.rotation_euler = (math.radians(50), 0, math.radians(-30))
scene.collection.objects.link(sun)
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 320
scene.render.resolution_y = 320
scene.render.film_transparent = False
scene.render.image_settings.file_format = "PNG"
if scene.world is None:
    scene.world = bpy.data.worlds.new("ThumbWorld")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.35, 0.37, 0.4, 1)
scene.world.node_tree.nodes["Background"].inputs[1].default_value = 1.2

report = {}
groups = []
for name, path, loader in sources():
    objs = loader(path)
    groups.append((name, objs))

for name, objs in groups:
    for _, other in groups:
        for o in other:
            o.hide_render = other is not objs
    b = bounds(objs)
    if b is None:
        report[name] = {"error": "no meshes"}
        continue
    lo, hi = b
    size = hi - lo
    center = (lo + hi) / 2
    radius = max(size.length / 2, 0.05)
    # Front view: camera on -Y looking toward +Y (the glTF importer maps glTF +Z "front" to Blender -Y).
    dist = radius / math.tan(cam_data.angle / 2) * 1.15
    cam.location = center + Vector((0, -dist * 0.94, dist * 0.34))
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_data.clip_end = dist * 4
    scene.render.filepath = os.path.join(THUMBS, f"{name}.png")
    bpy.ops.render.render(write_still=True)
    report[name] = {
        "size_xyz_m": [round(v, 3) for v in size],
        "min_z": round(lo.z, 3),
        "triangles": triangles(objs),
        "meshes": sum(1 for o in objs if o.type == "MESH"),
        "materials": len({s.material.name for o in objs if o.type == "MESH" for s in o.material_slots if s.material}),
    }

for o in scene.objects:
    o.hide_render = False
inventory_path = os.path.join(THUMBS, "inventory.json")
existing = json.load(open(inventory_path)) if os.path.exists(inventory_path) else {}
existing.update(report)
with open(inventory_path, "w") as f:
    json.dump(existing, f, indent=1)
result = {"models": list(report), "total": len(sources())}
